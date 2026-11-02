use openblog_core::{
    collaboration::{
        AuthorizationAction, AuthorizationContext, AuthorizationPolicy, AuthorizationRole,
        AuthorizationTarget, CollaborationContract, MAX_AUTHORIZATION_BINDINGS,
        MAX_AUTHORIZATION_POLICY_BYTES,
    },
    generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::json;

const ACTIONS: [AuthorizationAction; 16] = [
    AuthorizationAction::ViewPublication,
    AuthorizationAction::ViewPublished,
    AuthorizationAction::ViewRevealed,
    AuthorizationAction::ViewContribution,
    AuthorizationAction::EditContribution,
    AuthorizationAction::Invite,
    AuthorizationAction::RevealContribution,
    AuthorizationAction::ApproveContribution,
    AuthorizationAction::Schedule,
    AuthorizationAction::Publish,
    AuthorizationAction::RemoveMember,
    AuthorizationAction::ManageRoles,
    AuthorizationAction::Export,
    AuthorizationAction::PlaceInSeries,
    AuthorizationAction::CreateSeries,
    AuthorizationAction::ArrangeReflection,
];

/// One allowed (action, target) pair in the role matrix.
type Grant = (AuthorizationAction, AuthorizationTarget<'static>);

fn contract(participant_ids: &[&str]) -> CollaborationContract {
    contract_with(participant_ids, &[], &[])
}

/// A collaboration revision with `(contribution, owner)` drafts and `(contribution, viewers)`
/// reveals.
fn contract_with(
    participant_ids: &[&str],
    contributions: &[(&str, &str)],
    reveals: &[(&str, &[&str])],
) -> CollaborationContract {
    let participants = participant_ids
        .iter()
        .map(|id| json!({ "id": id, "displayName": format!("Participant {id}") }))
        .collect::<Vec<_>>();
    let contributions = contributions
        .iter()
        .map(|(id, owner)| {
            json!({ "id": id, "participantId": owner, "markdown": format!("Private {id}") })
        })
        .collect::<Vec<_>>();
    let reveals = reveals
        .iter()
        .map(|(id, viewers)| json!({ "contributionId": id, "participantIds": viewers }))
        .collect::<Vec<_>>();
    CollaborationContract::from_json(
        &json!({
            "version": 1,
            "revision": 3,
            "participants": participants,
            "contributions": contributions,
            "reveals": reveals,
            "layout": [],
            "approvals": []
        })
        .to_string(),
    )
    .expect("valid collaboration contract")
}

/// Ada and Grace each own one draft; Grace has revealed hers to Ada only.
fn group() -> CollaborationContract {
    contract_with(
        &["ada-participant", "grace-participant", "linus-participant"],
        &[
            ("ada-draft", "ada-participant"),
            ("grace-draft", "grace-participant"),
        ],
        &[("grace-draft", &["ada-participant"])],
    )
}

fn binding(role: &str) -> serde_json::Value {
    json!({
        "adminUser": "ada-admin",
        "contributorId": "ada",
        "participantId": "ada-participant",
        "roles": [role]
    })
}

fn policy(bindings: serde_json::Value) -> AuthorizationPolicy {
    AuthorizationPolicy::from_json(&policy_json(bindings).to_string())
        .expect("valid authorization policy")
}

fn policy_json(bindings: serde_json::Value) -> serde_json::Value {
    json!({
        "version": 1,
        "revision": 7,
        "publicationId": "shared-reflection",
        "bindings": bindings
    })
}

/// Ada, signed in and present in the registry and the participant collection.
fn ada<'a>(
    collaboration: &'a CollaborationContract,
    target: AuthorizationTarget<'a>,
) -> AuthorizationContext<'a> {
    signed_in("ada-admin", collaboration, target)
}

/// One of Ada, Grace, or Linus, signed in while all three accounts and registry keys exist.
fn signed_in<'a>(
    admin_user: &'a str,
    collaboration: &'a CollaborationContract,
    target: AuthorizationTarget<'a>,
) -> AuthorizationContext<'a> {
    AuthorizationContext {
        publication_id: "shared-reflection",
        authenticated_admin_user: admin_user,
        active_admin_users: &["ada-admin", "grace-admin", "linus-admin"],
        contributor_ids: &["ada", "grace", "linus"],
        collaboration,
        target,
    }
}

fn bound(name: &str, roles: &[&str]) -> serde_json::Value {
    json!({
        "adminUser": format!("{name}-admin"),
        "contributorId": name,
        "participantId": format!("{name}-participant"),
        "roles": roles
    })
}

/// Every target shape a request could name against `group()`, including unknown IDs and Linus,
/// a participant with no binding.
fn every_target() -> [AuthorizationTarget<'static>; 8] {
    [
        AuthorizationTarget::Publication,
        AuthorizationTarget::Participant("ada-participant"),
        AuthorizationTarget::Participant("grace-participant"),
        AuthorizationTarget::Participant("linus-participant"),
        AuthorizationTarget::Participant("missing-participant"),
        AuthorizationTarget::Contribution("ada-draft"),
        AuthorizationTarget::Contribution("grace-draft"),
        AuthorizationTarget::Contribution("missing-draft"),
    ]
}

#[test]
fn contributor_registry_entries_and_unbound_accounts_grant_zero_access() {
    let collaboration = group();
    // Ada has an Admin login, a registry entry, and a participant record, but no binding;
    // a binding for someone else must not leak to her either.
    let grace_only = policy(json!([{
        "adminUser": "grace-admin",
        "contributorId": "grace",
        "participantId": "grace-participant",
        "roles": ["siteOwner", "coordinator", "contributor", "editor", "reader"]
    }]));
    for policy in [policy(json!([])), grace_only] {
        for action in ACTIONS {
            for target in every_target() {
                let error = policy
                    .authorize(&ada(&collaboration, target), action)
                    .expect_err("a registry entry and login without a binding must be denied");
                assert_eq!(error.to_string(), "collaboration access denied");
            }
        }
    }
}

#[test]
fn every_role_action_combination_is_explicit() {
    use AuthorizationAction::*;
    use AuthorizationRole::*;
    use AuthorizationTarget::{Contribution as Draft, Participant, Publication};

    let collaboration = group();
    let ada_target = Participant("ada-participant");
    let grace_target = Participant("grace-participant");
    let linus_target = Participant("linus-participant");
    // Ada holds one role. Without a Grace binding Ada's own binding is the only possible site
    // owner; with one, Grace holds `siteOwner` too, so the sweep pins both "Any" and "Not a site
    // owner" for membership. Linus is a participant with no binding in either policy.
    for grace_site_owner in [false, true] {
        // (role, wire name, allowed (action, target) pairs); every other pair must be denied.
        let cases: [(AuthorizationRole, &str, Vec<Grant>); 5] = [
            (SiteOwner, "siteOwner", {
                let mut grants = vec![
                    (ViewPublication, Publication),
                    (ViewPublished, Publication),
                    (ViewRevealed, Draft("grace-draft")),
                    (Invite, Publication),
                    (Schedule, Publication),
                    (Publish, Publication),
                    (RemoveMember, grace_target),
                    (RemoveMember, linus_target),
                    (ManageRoles, ada_target),
                    (ManageRoles, grace_target),
                    (ManageRoles, linus_target),
                    (Export, Publication),
                    (PlaceInSeries, Publication),
                    (ArrangeReflection, Publication),
                    (CreateSeries, Publication),
                ];
                // The last site owner cannot remove themselves.
                if grace_site_owner {
                    grants.push((RemoveMember, ada_target));
                }
                grants
            }),
            (Coordinator, "coordinator", {
                let mut grants = vec![
                    (ViewPublication, Publication),
                    (ViewPublished, Publication),
                    (ViewRevealed, Draft("grace-draft")),
                    (Invite, Publication),
                    (Schedule, Publication),
                    (Publish, Publication),
                    (RemoveMember, ada_target),
                    (RemoveMember, linus_target),
                    (ManageRoles, ada_target),
                    (ManageRoles, linus_target),
                    (Export, Publication),
                    (PlaceInSeries, Publication),
                    (ArrangeReflection, Publication),
                ];
                if !grace_site_owner {
                    grants.extend([(RemoveMember, grace_target), (ManageRoles, grace_target)]);
                }
                grants
            }),
            (
                Contributor,
                "contributor",
                vec![
                    (ViewPublication, Publication),
                    (ViewPublished, Publication),
                    (ViewRevealed, Draft("grace-draft")),
                    (ViewContribution, Draft("ada-draft")),
                    (EditContribution, Draft("ada-draft")),
                    (RevealContribution, Draft("ada-draft")),
                    (ApproveContribution, ada_target),
                    (Export, Publication),
                ],
            ),
            (
                Editor,
                "editor",
                vec![
                    (ViewPublication, Publication),
                    (ViewPublished, Publication),
                    (ViewRevealed, Draft("grace-draft")),
                    (ViewContribution, Draft("ada-draft")),
                    (ViewContribution, Draft("grace-draft")),
                    (EditContribution, Draft("ada-draft")),
                    (EditContribution, Draft("grace-draft")),
                    (Export, Publication),
                ],
            ),
            (
                Reader,
                "reader",
                vec![
                    (ViewPublication, Publication),
                    (ViewPublished, Publication),
                    (ViewRevealed, Draft("grace-draft")),
                    (Export, Publication),
                ],
            ),
        ];

        for (role, wire_role, allowed) in cases {
            let mut bindings = vec![binding(wire_role)];
            if grace_site_owner {
                bindings.push(bound("grace", &["siteOwner"]));
            }
            let policy = policy(json!(bindings));
            for action in ACTIONS {
                for target in every_target() {
                    assert_eq!(
                        policy
                            .authorize(&ada(&collaboration, target), action)
                            .is_ok(),
                        allowed.contains(&(action, target)),
                        "unexpected {role:?} decision for {action:?} on {target:?} \
                         (grace site owner: {grace_site_owner})"
                    );
                }
            }
        }
    }
}

#[test]
fn confused_deputy_requests_cannot_act_for_another_participant() {
    use AuthorizationAction::*;

    // Grace's draft is not revealed to Linus, and Ada's draft is revealed to nobody.
    let collaboration = group();
    let every_role = policy(json!([{
        "adminUser": "ada-admin",
        "contributorId": "ada",
        "participantId": "ada-participant",
        "roles": ["siteOwner", "coordinator", "contributor", "editor", "reader"]
    }]));

    // Ownership comes from the server-side contract, never from the request: naming Grace's
    // draft is a request about Grace's prose however the caller labels it.
    for action in [RevealContribution, ApproveContribution] {
        for target in [
            AuthorizationTarget::Contribution("grace-draft"),
            AuthorizationTarget::Participant("grace-participant"),
        ] {
            assert!(
                every_role
                    .authorize(&ada(&collaboration, target), action)
                    .is_err(),
                "no role may {action:?} for another participant via {target:?}"
            );
        }
    }

    // A contributor can only reach another draft that has been revealed to them.
    let contributor = policy(json!([binding("contributor")]));
    for action in [ViewContribution, EditContribution, RevealContribution] {
        assert!(contributor
            .authorize(
                &ada(
                    &collaboration,
                    AuthorizationTarget::Contribution("grace-draft")
                ),
                action
            )
            .is_err());
    }

    // An editor and a viewer reach only drafts revealed to their own participant.
    let linus = |target| AuthorizationContext {
        publication_id: "shared-reflection",
        authenticated_admin_user: "linus-admin",
        active_admin_users: &["linus-admin"],
        contributor_ids: &["linus"],
        collaboration: &collaboration,
        target,
    };
    let linus_policy = policy(json!([{
        "adminUser": "linus-admin",
        "contributorId": "linus",
        "participantId": "linus-participant",
        "roles": ["siteOwner", "coordinator", "contributor", "editor", "reader"]
    }]));
    for action in [ViewRevealed, ViewContribution, EditContribution] {
        for draft in ["ada-draft", "grace-draft"] {
            assert!(
                linus_policy
                    .authorize(&linus(AuthorizationTarget::Contribution(draft)), action)
                    .is_err(),
                "{action:?} on unrevealed {draft} must be denied"
            );
        }
    }

    // A target of the wrong kind is a confused request, not a wildcard.
    for (action, target) in [
        (
            ViewPublished,
            AuthorizationTarget::Contribution("ada-draft"),
        ),
        (Publish, AuthorizationTarget::Participant("ada-participant")),
        (
            ViewPublication,
            AuthorizationTarget::Participant("ada-participant"),
        ),
        (
            EditContribution,
            AuthorizationTarget::Participant("ada-participant"),
        ),
        (EditContribution, AuthorizationTarget::Publication),
        (
            ApproveContribution,
            AuthorizationTarget::Contribution("ada-draft"),
        ),
        (RemoveMember, AuthorizationTarget::Publication),
    ] {
        assert!(every_role
            .authorize(&ada(&collaboration, target), action)
            .is_err());
    }
}

#[test]
fn coordinators_cannot_remove_a_site_owner() {
    let collaboration = group();
    let bindings = |grace_roles: &[&str], ada_role: &str| {
        policy(json!([
            binding(ada_role),
            {
                "adminUser": "grace-admin",
                "contributorId": "grace",
                "participantId": "grace-participant",
                "roles": grace_roles
            }
        ]))
    };
    let remove_grace = ada(
        &collaboration,
        AuthorizationTarget::Participant("grace-participant"),
    );

    assert!(bindings(&["siteOwner"], "coordinator")
        .authorize(&remove_grace, AuthorizationAction::RemoveMember)
        .is_err());
    assert!(bindings(&["siteOwner"], "siteOwner")
        .authorize(&remove_grace, AuthorizationAction::RemoveMember)
        .is_ok());
    assert!(bindings(&["coordinator", "contributor"], "coordinator")
        .authorize(&remove_grace, AuthorizationAction::RemoveMember)
        .is_ok());
}

#[test]
fn the_last_site_owner_cannot_be_removed() {
    let collaboration = group();
    let remove = |admin_user, participant| {
        signed_in(
            admin_user,
            &collaboration,
            AuthorizationTarget::Participant(participant),
        )
    };
    let sole_owner = policy(json!([
        bound("ada", &["siteOwner"]),
        bound("grace", &["coordinator"])
    ]));
    for admin_user in ["ada-admin", "grace-admin"] {
        assert!(
            sole_owner
                .authorize(
                    &remove(admin_user, "ada-participant"),
                    AuthorizationAction::RemoveMember
                )
                .is_err(),
            "{admin_user} removed the last site owner"
        );
    }

    let two_owners = policy(json!([
        bound("ada", &["siteOwner"]),
        bound("grace", &["siteOwner"])
    ]));
    for (admin_user, participant) in [
        ("ada-admin", "ada-participant"),
        ("ada-admin", "grace-participant"),
        ("grace-admin", "ada-participant"),
    ] {
        two_owners
            .authorize(
                &remove(admin_user, participant),
                AuthorizationAction::RemoveMember,
            )
            .expect("a site owner may leave or remove another while one remains");
    }
}

/// Changing a binding is the most privileged membership operation, so the replacement itself
/// carries the requester and applies `ManageRoles` to every binding it adds, changes, or removes.
#[test]
fn policy_replacement_cannot_escalate_to_or_strip_site_owner() {
    let collaboration = group();
    let current = policy(json!([
        bound("ada", &["siteOwner"]),
        bound("grace", &["coordinator"]),
        bound("linus", &["contributor"])
    ]));
    let replace = |admin_user: &str, bindings: serde_json::Value| {
        let mut replacement = policy_json(bindings);
        replacement["revision"] = json!(8);
        current.replace_from_json(
            &signed_in(admin_user, &collaboration, AuthorizationTarget::Publication),
            &replacement.to_string(),
            7,
        )
    };
    let ada = bound("ada", &["siteOwner"]);
    let grace = bound("grace", &["coordinator"]);
    let linus = bound("linus", &["contributor"]);
    let newcomer = json!({
        "adminUser": "mary-admin",
        "contributorId": "mary",
        "participantId": "mary-participant",
        "roles": ["siteOwner"]
    });

    // Grace, a coordinator, can never touch a site-owner binding or create one.
    let mut ada_renamed = ada.clone();
    ada_renamed["contributorId"] = json!("ada-renamed");
    for bindings in [
        json!([bound("ada", &["coordinator"]), grace, linus]),
        json!([ada, bound("grace", &["coordinator", "siteOwner"]), linus]),
        json!([ada, grace, bound("linus", &["siteOwner"])]),
        json!([ada, grace, linus, newcomer]),
        json!([grace, linus]),
        json!([ada_renamed, grace, linus]),
    ] {
        let error = replace("grace-admin", bindings.clone())
            .expect_err("a coordinator must not grant or strip siteOwner");
        assert_eq!(
            error.to_string(),
            "collaboration access denied",
            "{bindings}"
        );
    }
    // She may still manage bindings that do not hold siteOwner, in any order.
    let mut reader = newcomer.clone();
    reader["roles"] = json!(["reader"]);
    for bindings in [
        json!([ada, grace, bound("linus", &["contributor", "editor"])]),
        json!([ada, grace]),
        json!([linus, grace, ada, reader]),
        json!([ada, bound("grace", &["coordinator", "contributor"]), linus]),
    ] {
        replace("grace-admin", bindings.clone()).expect("coordinator manages non-owners");
    }

    // Roles without membership authority cannot change any binding, even to add a reader.
    for bindings in [
        json!([ada, grace, linus, reader]),
        json!([ada, grace, bound("linus", &["contributor", "editor"])]),
        json!([ada, grace, linus]),
    ] {
        assert!(replace("linus-admin", bindings).is_err());
    }

    // A site owner may grant and revoke siteOwner, but the policy must keep one.
    replace(
        "ada-admin",
        json!([ada, bound("grace", &["coordinator", "siteOwner"]), linus]),
    )
    .expect("a site owner may grant siteOwner");
    replace("ada-admin", json!([ada, linus, newcomer]))
        .expect("a site owner may remove a coordinator and add another site owner");
    for bindings in [
        json!([bound("ada", &["coordinator"]), grace, linus]),
        json!([grace, linus]),
    ] {
        assert!(
            replace("ada-admin", bindings).is_err(),
            "the last site owner cannot be revoked"
        );
    }
    let two_owners = policy(json!([ada, bound("grace", &["siteOwner"])]));
    let mut handover = policy_json(json!([bound("grace", &["siteOwner"])]));
    handover["revision"] = json!(8);
    two_owners
        .replace_from_json(&ada_context(&collaboration), &handover.to_string(), 7)
        .expect("a site owner may leave while another remains");

    // A requester whose own identity is stale cannot replace anything.
    assert!(current
        .replace_from_json(
            &AuthorizationContext {
                active_admin_users: &[],
                ..ada_context(&collaboration)
            },
            &json!({
                "version": 1,
                "revision": 8,
                "publicationId": "shared-reflection",
                "bindings": [ada, grace, linus]
            })
            .to_string(),
            7,
        )
        .is_err());
}

/// Only roles are editable through replacement. A binding's account, registry key, and
/// participant stay fixed, and a new binding cannot take over a participant who already has
/// drafts, reveals, or approvals, so neither a coordinator nor a site owner can become another
/// participant or hand that participant to an accomplice.
#[test]
fn policy_replacement_cannot_take_over_another_participant() {
    use AuthorizationAction::*;

    let collaboration = contract_with(
        &["ada-participant", "grace-participant", "linus-participant"],
        &[
            ("ada-draft", "ada-participant"),
            ("grace-draft", "grace-participant"),
            ("linus-draft", "linus-participant"),
        ],
        &[("grace-draft", &["ada-participant"])],
    );
    let admins = ["ada-admin", "grace-admin", "linus-admin", "mallory-admin"];
    let contributors = ["ada", "grace", "linus", "mallory"];
    let context = |admin_user| AuthorizationContext {
        publication_id: "shared-reflection",
        authenticated_admin_user: admin_user,
        active_admin_users: &admins,
        contributor_ids: &contributors,
        collaboration: &collaboration,
        target: AuthorizationTarget::Publication,
    };
    let ada = bound("ada", &["siteOwner"]);
    let grace = bound("grace", &["coordinator"]);
    let linus = bound("linus", &["contributor"]);
    let current = policy(json!([ada, grace, linus]));
    let source = |revision: u64, bindings: serde_json::Value| {
        let mut replacement = policy_json(bindings);
        replacement["revision"] = json!(revision);
        replacement.to_string()
    };
    let identity = |admin_user: &str, contributor_id: &str, participant_id: &str, roles| {
        json!({
            "adminUser": admin_user,
            "contributorId": contributor_id,
            "participantId": participant_id,
            "roles": roles
        })
    };
    let linus_denied = |policy: &AuthorizationPolicy| {
        for admin_user in ["ada-admin", "grace-admin", "mallory-admin"] {
            for (action, target) in [
                (
                    ViewContribution,
                    AuthorizationTarget::Contribution("linus-draft"),
                ),
                (
                    EditContribution,
                    AuthorizationTarget::Contribution("linus-draft"),
                ),
                (
                    RevealContribution,
                    AuthorizationTarget::Contribution("linus-draft"),
                ),
                (
                    ApproveContribution,
                    AuthorizationTarget::Participant("linus-participant"),
                ),
            ] {
                assert!(
                    policy
                        .authorize(
                            &AuthorizationContext {
                                target,
                                ..context(admin_user)
                            },
                            action
                        )
                        .is_err(),
                    "{admin_user} gained {action:?} on Linus's draft"
                );
            }
        }
    };
    linus_denied(&current);

    for requester in ["grace-admin", "ada-admin"] {
        let (own, own_roles) = if requester == "ada-admin" {
            (ada.clone(), json!(["siteOwner", "contributor"]))
        } else {
            (grace.clone(), json!(["coordinator", "contributor"]))
        };
        let own_name = requester.trim_end_matches("-admin");
        let others = |exclude: &serde_json::Value| {
            [&ada, &grace]
                .into_iter()
                .filter(|binding| *binding != exclude)
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut attacks = vec![
            // In place: Linus's participant gets another account, or another registry key.
            json!([
                ada,
                grace,
                identity(
                    "mallory-admin",
                    "mallory",
                    "linus-participant",
                    json!(["contributor"])
                )
            ]),
            json!([
                ada,
                grace,
                identity(
                    "mallory-admin",
                    "linus",
                    "linus-participant",
                    json!(["contributor"])
                )
            ]),
            json!([
                ada,
                grace,
                identity(
                    "linus-admin",
                    "mallory",
                    "linus-participant",
                    json!(["contributor"])
                )
            ]),
        ];
        // Self-move: the requester drops Linus and moves their own binding onto his participant.
        let mut moved = others(&own);
        moved.push(identity(
            requester,
            own_name,
            "linus-participant",
            own_roles.clone(),
        ));
        attacks.push(json!(moved));
        // The same move under a case variant of Linus's participant ID.
        let mut cased = others(&own);
        cased.push(identity(
            requester,
            own_name,
            "Linus-Participant",
            own_roles.clone(),
        ));
        attacks.push(json!(cased));
        // Moving only the account or only the registry key onto a fresh participant.
        let mut fresh_account = others(&own);
        fresh_account.extend([
            identity(requester, "mallory", "fresh-participant", own_roles.clone()),
            linus.clone(),
        ]);
        attacks.push(json!(fresh_account));
        let mut fresh_key = others(&own);
        fresh_key.extend([
            identity(
                "mallory-admin",
                own_name,
                "fresh-participant",
                own_roles.clone(),
            ),
            linus.clone(),
        ]);
        attacks.push(json!(fresh_key));
        for bindings in attacks {
            assert!(
                current
                    .replace_from_json(&context(requester), &source(8, bindings.clone()), 7)
                    .is_err(),
                "{requester} took over a participant with {bindings}"
            );
        }

        // Remove, then re-add Linus's participant under another account in the next revision.
        let without_linus = current
            .replace_from_json(&context(requester), &source(8, json!([ada, grace])), 7)
            .expect("a membership manager may remove a non-owner");
        for bindings in [
            json!([
                ada,
                grace,
                identity(
                    "mallory-admin",
                    "mallory",
                    "linus-participant",
                    json!(["contributor"])
                )
            ]),
            json!([
                ada,
                grace,
                identity(
                    "mallory-admin",
                    "mallory",
                    "LINUS-participant",
                    json!(["contributor"])
                )
            ]),
        ] {
            assert!(
                without_linus
                    .replace_from_json(&context(requester), &source(9, bindings.clone()), 8)
                    .is_err(),
                "{requester} re-bound Linus's participant with {bindings}"
            );
        }
        linus_denied(&without_linus);

        // Roles stay editable, and new people join as new participants.
        for bindings in [
            json!([ada, grace, bound("linus", &["contributor", "editor"])]),
            json!([linus, grace, ada]),
            json!([ada, grace, linus, bound("mallory", &["contributor"])]),
        ] {
            current
                .replace_from_json(&context(requester), &source(8, bindings.clone()), 7)
                .unwrap_or_else(|_| panic!("{requester} may make {bindings}"));
        }
    }
    linus_denied(&current);

    // A participant who appears only as a reveal recipient or an approver is taken too.
    let participant = |id: &str| json!({ "id": id, "displayName": format!("Participant {id}") });
    for (reveals, approvals) in [
        (
            json!([{ "contributionId": "ada-draft", "participantIds": ["linus-participant"] }]),
            json!([]),
        ),
        (
            json!([]),
            json!([{ "participantId": "linus-participant", "revision": 3 }]),
        ),
    ] {
        let collaboration = CollaborationContract::from_json(
            &json!({
                "version": 1,
                "revision": 3,
                "participants": [
                    participant("ada-participant"),
                    participant("linus-participant"),
                    participant("idle-participant")
                ],
                "contributions": [
                    { "id": "ada-draft", "participantId": "ada-participant", "markdown": "Ada" }
                ],
                "reveals": reveals,
                "layout": [],
                "approvals": approvals
            })
            .to_string(),
        )
        .expect("valid collaboration contract");
        let owner = AuthorizationContext {
            collaboration: &collaboration,
            ..context("ada-admin")
        };
        let only_ada = policy(json!([ada]));
        assert!(only_ada
            .replace_from_json(
                &owner,
                &source(
                    8,
                    json!([
                        ada,
                        identity(
                            "mallory-admin",
                            "mallory",
                            "linus-participant",
                            json!(["reader"])
                        )
                    ])
                ),
                7,
            )
            .is_err());
        // A participant record with nothing attached may still be bound.
        only_ada
            .replace_from_json(
                &owner,
                &source(
                    8,
                    json!([
                        ada,
                        identity(
                            "mallory-admin",
                            "mallory",
                            "idle-participant",
                            json!(["reader"])
                        )
                    ]),
                ),
                7,
            )
            .expect("an idle participant may be bound");
    }
}

/// A site-owner binding whose account, registry key, or participant is gone can authorize
/// nothing, so it does not count as the site owner that must remain.
#[test]
fn stale_site_owners_do_not_count_as_the_remaining_site_owner() {
    let collaboration = group();
    let without_grace = contract(&["ada-participant", "linus-participant"]);
    let two_owners = policy(json!([
        bound("ada", &["siteOwner"]),
        bound("grace", &["siteOwner"])
    ]));
    let mut demoted = policy_json(json!([
        bound("ada", &["coordinator"]),
        bound("grace", &["siteOwner"])
    ]));
    demoted["revision"] = json!(8);
    let mut handover = policy_json(json!([bound("grace", &["siteOwner"])]));
    handover["revision"] = json!(8);
    let mut drop_grace = policy_json(json!([bound("ada", &["siteOwner"])]));
    drop_grace["revision"] = json!(8);

    let stale = [
        AuthorizationContext {
            active_admin_users: &["ada-admin", "linus-admin"],
            ..ada_context(&collaboration)
        },
        AuthorizationContext {
            contributor_ids: &["ada", "linus"],
            ..ada_context(&collaboration)
        },
        ada_context(&without_grace),
    ];
    for context in stale {
        assert!(two_owners
            .authorize(
                &AuthorizationContext {
                    target: AuthorizationTarget::Participant("ada-participant"),
                    ..context
                },
                AuthorizationAction::RemoveMember,
            )
            .is_err());
        for source in [&demoted, &handover] {
            assert!(two_owners
                .replace_from_json(&context, &source.to_string(), 7)
                .is_err());
        }
        two_owners
            .replace_from_json(&context, &drop_grace.to_string(), 7)
            .expect("the current site owner may drop a stale one");
    }

    // With both owners current, either may leave.
    let context = ada_context(&collaboration);
    for source in [&demoted, &handover] {
        two_owners
            .replace_from_json(&context, &source.to_string(), 7)
            .expect("a site owner may leave while a current one remains");
    }
}

/// Roles are a set, so a client that re-sorts them changes nothing.
#[test]
fn policy_replacement_compares_roles_as_a_set() {
    let collaboration = group();
    let current = policy(json!([
        bound("ada", &["siteOwner", "contributor"]),
        bound("grace", &["coordinator"]),
        bound("linus", &["contributor"])
    ]));
    let mut reordered = policy_json(json!([
        bound("ada", &["contributor", "siteOwner"]),
        bound("grace", &["coordinator"]),
        bound("linus", &["editor", "contributor"])
    ]));
    reordered["revision"] = json!(8);
    current
        .replace_from_json(
            &signed_in(
                "grace-admin",
                &collaboration,
                AuthorizationTarget::Publication,
            ),
            &reordered.to_string(),
            7,
        )
        .expect("re-sorting a site owner's roles is not a change");
}

fn ada_context(collaboration: &CollaborationContract) -> AuthorizationContext<'_> {
    ada(collaboration, AuthorizationTarget::Publication)
}

#[test]
fn policy_replacement_is_atomic_revision_checked_and_publication_scoped() {
    let collaboration = group();
    let requester = ada_context(&collaboration);
    let current = policy(json!([binding("siteOwner")]));
    let mut replacement = policy_json(json!([{
        "adminUser": "ada-admin",
        "contributorId": "ada",
        "participantId": "ada-participant",
        "roles": ["siteOwner", "contributor"]
    }]));
    replacement["revision"] = json!(8);

    let updated = current
        .replace_from_json(&requester, &replacement.to_string(), 7)
        .expect("matching revision and publication replace the whole policy");
    assert_eq!(updated.revision, 8);
    assert_eq!(
        updated.bindings[0].roles,
        [AuthorizationRole::SiteOwner, AuthorizationRole::Contributor]
    );

    // Stale observers, replays of the current revision, skipped revisions, a different
    // publication, and a malformed body all fail without touching the current policy.
    let mut replayed = replacement.clone();
    replayed["revision"] = json!(7);
    let mut skipped = replacement.clone();
    skipped["revision"] = json!(9);
    let mut wrong_publication = replacement.clone();
    wrong_publication["publicationId"] = json!("another-publication");
    let mut hostile = replacement.clone();
    hostile["bindings"][0]["adminUser"] = json!("<script>alert(1)</script>");
    for (source, observed) in [
        (replacement.to_string(), 6),
        (replayed.to_string(), 7),
        (skipped.to_string(), 7),
        (wrong_publication.to_string(), 7),
        (hostile.to_string(), 7),
        ("{\"version\":1,".to_string(), 7),
    ] {
        let error = current
            .replace_from_json(&requester, &source, observed)
            .expect_err("unsafe replacement must fail");
        assert_eq!(error.to_string(), "collaboration access denied");
    }
    assert_eq!(current, policy(json!([binding("siteOwner")])));

    let exhausted = AuthorizationPolicy {
        revision: u64::MAX,
        ..current.clone()
    };
    let mut overflow = replacement;
    overflow["revision"] = json!(0);
    assert!(exhausted
        .replace_from_json(&requester, &overflow.to_string(), u64::MAX)
        .is_err());
}

#[test]
fn removed_renamed_and_cross_publication_identities_fail_as_one_private_error() {
    let policy = policy(json!([binding("contributor")]));
    let collaboration = contract_with(
        &["ada-participant"],
        &[("ada-draft", "ada-participant")],
        &[],
    );
    let removed_participant = contract(&["grace-participant"]);
    let own_draft = AuthorizationTarget::Contribution("ada-draft");
    policy
        .authorize(
            &ada(&collaboration, own_draft),
            AuthorizationAction::EditContribution,
        )
        .expect("the current binding is the positive control");
    let cases = [
        // Removed Admin user: the account no longer exists even if a session lingers.
        AuthorizationContext {
            active_admin_users: &[],
            ..ada(&collaboration, own_draft)
        },
        // Renamed contributor: the binding points at a registry key that no longer exists.
        AuthorizationContext {
            contributor_ids: &["ada-renamed"],
            ..ada(&collaboration, own_draft)
        },
        // Removed participant: the contract no longer lists the bound participant.
        ada(&removed_participant, AuthorizationTarget::Publication),
        // Cross-publication use of an otherwise valid binding.
        AuthorizationContext {
            publication_id: "another-publication",
            ..ada(&collaboration, own_draft)
        },
        // Another signed-in account claiming Ada's binding.
        AuthorizationContext {
            authenticated_admin_user: "grace-admin",
            ..ada(&collaboration, own_draft)
        },
    ];

    for context in cases {
        for action in ACTIONS {
            let error = policy
                .authorize(&context, action)
                .expect_err("stale or cross-publication identity must be denied");
            assert_eq!(error.to_string(), "collaboration access denied");
            assert_eq!(format!("{error:?}"), "AuthorizationError");
        }
    }
}

#[test]
fn access_roles_authorize_actions_without_creating_authorship_or_approval() {
    let policy = policy(json!([{
        "adminUser": "ada-admin",
        "contributorId": "ada",
        "participantId": "ada-participant",
        "roles": ["siteOwner", "coordinator", "contributor"]
    }]));
    let collaboration = group();
    let before = collaboration.clone();

    let grant = policy
        .authorize(
            &ada(
                &collaboration,
                AuthorizationTarget::Participant("ada-participant"),
            ),
            AuthorizationAction::ApproveContribution,
        )
        .expect("the contributor role permits the participant to submit an approval");
    assert_eq!(grant.contributor_id, "ada");
    assert_eq!(grant.participant_id, "ada-participant");
    for action in [AuthorizationAction::Publish, AuthorizationAction::Schedule] {
        policy
            .authorize(
                &ada(&collaboration, AuthorizationTarget::Publication),
                action,
            )
            .expect("site owner may request the action");
    }
    assert_eq!(
        collaboration, before,
        "authorization must not manufacture an approval or change drafts"
    );
    assert!(collaboration.approvals.is_empty());

    let serialized = serde_json::to_value(policy).expect("serialize policy");
    let encoded = serialized.to_string();
    for forbidden in ["author", "authorship", "approval", "approved", "credit"] {
        assert!(!encoded.contains(forbidden));
    }
}

#[test]
fn bound_identities_follow_the_admin_username_and_registry_key_rules() {
    let with = |field: &str, value: serde_json::Value| {
        let mut binding = binding("reader");
        binding[field] = value;
        AuthorizationPolicy::from_json(&policy_json(json!([binding])).to_string())
    };

    // Any Admin username can be bound, including names that are not contract identifiers.
    for admin_user in [
        "mikey",
        "mikey_1",
        "m.nichols",
        "con",
        "-x",
        "a".repeat(32).as_str(),
    ] {
        assert!(with("adminUser", json!(admin_user)).is_ok(), "{admin_user}");
    }
    for contributor_id in ["ada", "ada-lovelace", "site-2"] {
        assert!(
            with("contributorId", json!(contributor_id)).is_ok(),
            "{contributor_id}"
        );
    }

    let rejected = [
        ("adminUser", json!("")),
        ("adminUser", json!("Ada-admin")),
        ("adminUser", json!("a".repeat(33))),
        ("adminUser", json!("ada/admin")),
        ("adminUser", json!("ada admin")),
        ("adminUser", json!("\u{0430}da-admin")),
        ("adminUser", json!("ada\u{202E}nimda")),
        ("adminUser", json!("ada\u{0000}")),
        ("adminUser", json!(7)),
        ("contributorId", json!("Ada")),
        ("contributorId", json!("ada_lovelace")),
        ("contributorId", json!("ada--lovelace")),
        ("contributorId", json!("-ada")),
        ("contributorId", json!("../ada")),
        ("contributorId", json!("a".repeat(129))),
        ("participantId", json!("../ada")),
        ("participantId", json!("con")),
        ("participantId", json!("ada participant")),
        ("roles", json!([])),
        ("roles", json!("reader")),
        ("roles", json!(["admin"])),
        ("roles", json!(["Reader"])),
        ("roles", json!(["reader", "reader"])),
    ];
    for (field, value) in rejected {
        let error = with(field, value.clone())
            .expect_err("an identity that cannot be authenticated or resolved must fail");
        assert_eq!(
            error.to_string(),
            "collaboration access denied",
            "{field}: {value}"
        );
    }
}

#[test]
fn policy_shape_is_bounded_group_safe_and_rejects_untrusted_fields() {
    assert_eq!(MAX_AUTHORIZATION_BINDINGS, 100);
    assert_eq!(MAX_AUTHORIZATION_POLICY_BYTES, 64 * 1024);

    // The first binding coordinates, the last is the only site owner, and the rest read.
    let bindings = |count: usize| {
        (0..count)
            .map(|index| {
                let role = if index + 1 == count {
                    "siteOwner"
                } else if index == 0 {
                    "coordinator"
                } else {
                    "reader"
                };
                json!({
                    "adminUser": format!("admin-{index}"),
                    "contributorId": format!("contributor-{index}"),
                    "participantId": format!("participant-{index}"),
                    "roles": [role]
                })
            })
            .collect::<Vec<_>>()
    };
    for count in [1, 2, 3, 10, MAX_AUTHORIZATION_BINDINGS] {
        let parsed = policy(json!(bindings(count)));
        assert_eq!(parsed.bindings.len(), count);

        // Every binding's account and registry key exist, plus one account with a login and a
        // registry key but no binding.
        let names = |prefix: &str, unbound: bool| {
            (0..count)
                .map(|index| format!("{prefix}-{index}"))
                .chain(unbound.then(|| format!("{prefix}-unbound")))
                .collect::<Vec<_>>()
        };
        let admins = names("admin", true);
        let contributors = names("contributor", true);
        let participants = names("participant", false);
        let [admins, contributors, participants] = [&admins, &contributors, &participants]
            .map(|names| names.iter().map(String::as_str).collect::<Vec<_>>());
        let collaboration = contract(&participants);
        let request = |admin_user: &str, action, target| {
            parsed.authorize(
                &AuthorizationContext {
                    publication_id: "shared-reflection",
                    authenticated_admin_user: admin_user,
                    active_admin_users: &admins,
                    contributor_ids: &contributors,
                    collaboration: &collaboration,
                    target,
                },
                action,
            )
        };
        use AuthorizationAction::{Publish, RemoveMember};
        let owner = admins[count - 1];
        let owner_target = AuthorizationTarget::Participant(participants[count - 1]);

        // The last binding resolves to its own participant and site-owner role.
        let grant = request(owner, Publish, AuthorizationTarget::Publication)
            .expect("the last binding is found in a large group");
        assert_eq!(grant.participant_id, participants[count - 1]);
        assert!(request("admin-unbound", Publish, AuthorizationTarget::Publication).is_err());
        // The site-owner scan finds the last binding: neither it nor the coordinator can remove
        // the only site owner, while the coordinator may remove a non-owner.
        assert!(
            request(owner, RemoveMember, owner_target).is_err(),
            "{count}"
        );
        if count > 1 {
            assert!(
                request("admin-0", RemoveMember, owner_target).is_err(),
                "{count}"
            );
            let first = AuthorizationTarget::Participant(participants[0]);
            request("admin-0", RemoveMember, first).expect("coordinator removes a non-owner");
            request(owner, RemoveMember, first).expect("site owner removes a non-owner");
        }
    }
    assert!(AuthorizationPolicy::from_json(
        &policy_json(json!(bindings(MAX_AUTHORIZATION_BINDINGS + 1))).to_string()
    )
    .is_err());
    let mut oversized = policy_json(json!([binding("reader")]));
    oversized["publicationId"] = json!("p".repeat(MAX_AUTHORIZATION_POLICY_BYTES));
    assert!(AuthorizationPolicy::from_json(&oversized.to_string()).is_err());

    let grace = |participant: &str| {
        json!({
            "adminUser": "grace-admin",
            "contributorId": "grace",
            "participantId": participant,
            "roles": ["reader"]
        })
    };
    let fixtures = [
        json!({
            "version": 1,
            "revision": 7,
            "publicationId": "shared-reflection",
            "bindings": [binding("reader")],
            "token": "participant-secret"
        }),
        policy_json(json!([{
            "adminUser": "ada-admin",
            "contributorId": "ada",
            "participantId": "ada-participant",
            "roles": ["reader"],
            "metadata": { "private": "other-user-data" }
        }])),
        policy_json(json!([{
            "adminUser": "ada-admin",
            "contributorId": "ada",
            "participantId": "ada-participant",
            "roles": ["reader"],
            "markdown": "<img src=x onerror=alert('other-user-data')>",
            "profileUrl": "javascript:alert('other-user-data')"
        }])),
        policy_json(json!([binding("reader"), binding("editor")])),
        policy_json(json!([binding("reader"), grace("Ada-Participant")])),
        policy_json(json!([binding("reader"), grace("ada-participant")])),
        json!({
            "version": 2,
            "revision": 7,
            "publicationId": "shared-reflection",
            "bindings": [binding("reader")]
        }),
        json!({
            "version": 1,
            "revision": 7,
            "publicationId": "../shared-reflection",
            "bindings": [binding("reader")]
        }),
    ];

    for invalid in fixtures {
        let error = AuthorizationPolicy::from_json(&invalid.to_string())
            .expect_err("untrusted or ambiguous policy must fail closed");
        assert_eq!(error.to_string(), "collaboration access denied");
        assert!(!error.to_string().contains("participant-secret"));
        assert!(!error.to_string().contains("other-user-data"));
    }
}

/// An isolation pin, not evidence about a publication seam: the site below never
/// receives collaboration or policy input, because none exists yet, so equal output is true by
/// construction. The test fails only if authorization gains a side effect it can observe here.
/// The real unchanged-output assertion belongs to the first collaboration-to-publication seam
/// (#156 and #158), which must route the policy through site loading and compare its output.
#[test]
fn authorization_has_no_publication_seam_to_change_output() {
    let build = || {
        let site = Site::load(
            SiteConfig::from_json(r#"{"author":{"name":"Site Author"}}"#).unwrap(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/reflection.md".into(),
                    contents: "---
title: Reflection
date: 2026-10-24
---
Published body."
                        .into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        generate(&site, &ThemeSet::new())
            .unwrap()
            .into_iter()
            .map(|file| (file.path, file.contents))
            .collect::<Vec<_>>()
    };
    let before = build();

    let collaboration = group();
    let current = policy(json!([binding("contributor")]));
    let snapshot = (collaboration.clone(), current.clone());
    for action in ACTIONS {
        for target in every_target() {
            let _ = current.authorize(
                &AuthorizationContext {
                    authenticated_admin_user: "grace-admin",
                    ..ada(&collaboration, target)
                },
                action,
            );
        }
    }
    let mut hostile = policy_json(json!([binding("contributor")]));
    hostile["revision"] = json!(8);
    hostile["bindings"][0]["markdown"] = json!("<script>Private grace-draft</script>");
    assert!(current
        .replace_from_json(&ada_context(&collaboration), &hostile.to_string(), 7)
        .is_err());
    assert!(AuthorizationPolicy::from_json(&hostile.to_string()).is_err());

    assert_eq!((collaboration, current), snapshot);
    let after = build();
    assert_eq!(before, after);
    for (_, contents) in &after {
        for private in [
            "Private grace-draft",
            "ada-admin",
            "ada-participant",
            "shared-reflection",
        ] {
            assert!(!contents.contains(private), "{private} leaked");
        }
    }
}

#[test]
fn editing_synthesis_is_a_contributors_own_participant_grant_only() {
    let collaboration = group();
    let own = AuthorizationTarget::Participant("ada-participant");
    for (role, allowed) in [
        ("contributor", true),
        ("siteOwner", false),
        ("coordinator", false),
        ("editor", false),
        ("reader", false),
    ] {
        let policy = policy(json!([binding(role)]));
        assert_eq!(
            policy
                .authorize(
                    &ada(&collaboration, own),
                    AuthorizationAction::EditSynthesis
                )
                .is_ok(),
            allowed,
            "{role}"
        );
    }
    let contributor = policy(json!([binding("contributor")]));
    for target in [
        AuthorizationTarget::Participant("grace-participant"),
        AuthorizationTarget::Publication,
        AuthorizationTarget::Contribution("ada-draft"),
    ] {
        assert!(contributor
            .authorize(
                &ada(&collaboration, target),
                AuthorizationAction::EditSynthesis
            )
            .is_err());
    }
}

#[test]
fn editing_media_moments_is_a_contributors_own_participant_grant_only() {
    let collaboration = group();
    let own = AuthorizationTarget::Participant("ada-participant");
    for (role, allowed) in [
        ("contributor", true),
        ("siteOwner", false),
        ("coordinator", false),
        ("editor", false),
        ("reader", false),
    ] {
        let policy = policy(json!([binding(role)]));
        assert_eq!(
            policy
                .authorize(&ada(&collaboration, own), AuthorizationAction::EditMoments)
                .is_ok(),
            allowed,
            "{role}"
        );
    }
    let contributor = policy(json!([binding("contributor")]));
    for target in [
        AuthorizationTarget::Participant("grace-participant"),
        AuthorizationTarget::Publication,
        AuthorizationTarget::Contribution("ada-draft"),
    ] {
        assert!(contributor
            .authorize(
                &ada(&collaboration, target),
                AuthorizationAction::EditMoments
            )
            .is_err());
    }
}
