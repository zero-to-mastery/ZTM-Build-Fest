use openblog_core::collaboration::{
    AuthorizationPolicy, CollaborationContract, MAX_APPROVALS, MAX_CONTRACT_BYTES,
    MAX_CONTRIBUTIONS, MAX_DISPLAY_NAME_BYTES, MAX_IDENTIFIER_BYTES, MAX_LAYOUT_ITEMS,
    MAX_MARKDOWN_BYTES, MAX_PARTICIPANTS, MAX_PROFILE_URL_BYTES, MAX_REGION_BYTES, MAX_REVEALS,
};
use serde_json::{json, Value};

fn contract_with(participant_ids: &[&str]) -> Value {
    let participants = participant_ids
        .iter()
        .map(|id| json!({ "id": id, "displayName": format!("Contributor {id}") }))
        .collect::<Vec<_>>();

    json!({
        "version": 1,
        "revision": 4,
        "participants": participants,
        "contributions": [],
        "reveals": [],
        "layout": [],
        "approvals": []
    })
}

fn populated_contract() -> Value {
    json!({
        "version": 1,
        "revision": 4,
        "participants": [
            { "id": "p0", "displayName": "First" },
            { "id": "p1", "displayName": "Second", "profileUrl": "https://example.org/second" },
            { "id": "p2", "displayName": "Third" }
        ],
        "contributions": [
            { "id": "c2", "participantId": "p2", "markdown": "Third" },
            { "id": "c0", "participantId": "p0", "markdown": "First" }
        ],
        "reveals": [
            { "contributionId": "c2", "participantIds": ["p0", "p1"] },
            { "contributionId": "c0", "participantIds": ["p2"] }
        ],
        "layout": [
            { "contributionId": "c0", "region": "opening" },
            { "contributionId": "c2", "region": "response" }
        ],
        "approvals": [
            { "participantId": "p2", "revision": 4 },
            { "participantId": "p0", "revision": 4 }
        ]
    })
}

#[test]
fn participant_collections_accept_group_sizes_and_preserve_authored_order() {
    for count in [1, 2, 3, 10] {
        let ids = (0..count)
            .map(|index| format!("p{index}"))
            .collect::<Vec<_>>();
        let borrowed = ids.iter().map(String::as_str).collect::<Vec<_>>();
        let contract = CollaborationContract::from_json(&contract_with(&borrowed).to_string())
            .expect("valid group contract");

        assert_eq!(
            contract
                .participants
                .iter()
                .map(|participant| participant.id.as_str())
                .collect::<Vec<_>>(),
            borrowed
        );
    }

    let reordered =
        CollaborationContract::from_json(&contract_with(&["p2", "p0", "p1"]).to_string())
            .expect("reordered participants remain valid");
    assert_eq!(
        reordered
            .participants
            .iter()
            .map(|participant| participant.id.as_str())
            .collect::<Vec<_>>(),
        ["p2", "p0", "p1"]
    );

    let pair_contract =
        CollaborationContract::from_json(&contract_with(&["lead", "guest"]).to_string())
            .expect("pair contract");
    let pair = pair_contract
        .pair_projection()
        .expect("exactly two participants project to pair slots");
    assert_eq!(pair.first.id, "lead");
    assert_eq!(pair.second.id, "guest");
}

#[test]
fn every_collaboration_collection_preserves_order_without_pair_fields() {
    let contract = CollaborationContract::from_json(&populated_contract().to_string())
        .expect("valid populated contract");

    assert_eq!(
        contract
            .contributions
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        ["c2", "c0"]
    );
    assert_eq!(contract.reveals[0].participant_ids, ["p0", "p1"]);
    assert_eq!(contract.layout[0].contribution_id, "c0");
    assert_eq!(contract.approvals[0].participant_id, "p2");

    let serialized = serde_json::to_value(&contract).expect("serialize contract");
    assert_no_pair_fields(&serialized);
    let policy = serde_json::to_value(
        AuthorizationPolicy::from_json(
            &json!({
                "version": 1,
                "revision": 1,
                "publicationId": "shared",
                "bindings": [
                    { "adminUser": "a", "contributorId": "a", "participantId": "p0", "roles": ["contributor"] },
                    { "adminUser": "b", "contributorId": "b", "participantId": "p1", "roles": ["contributor"] },
                    { "adminUser": "c", "contributorId": "c", "participantId": "p2", "roles": ["coordinator"] }
                ]
            })
            .to_string(),
        )
        .expect("group policy"),
    )
    .unwrap();
    assert_no_pair_fields(&policy);
}

/// Walk every persisted/API key so a pair-only field cannot hide in a nested entry.
fn assert_no_pair_fields(value: &Value) {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                let key = key.to_ascii_lowercase();
                assert!(
                    ![
                        "left", "right", "first", "second", "partner", "pair", "authora",
                        "authorb", "persona", "personb"
                    ]
                    .iter()
                    .any(|forbidden| key.contains(forbidden)),
                    "pair-specific field `{key}`"
                );
                assert_no_pair_fields(nested);
            }
        }
        Value::Array(items) => items.iter().for_each(assert_no_pair_fields),
        _ => {}
    }
}

#[test]
fn duplicate_and_removed_participant_fixtures_fail_as_one_private_error() {
    let mut duplicate = populated_contract();
    duplicate["participants"][1]["id"] = json!("p0");

    // Case-insensitive filesystems would map these IDs to one file key.
    let mut case_duplicate = populated_contract();
    case_duplicate["participants"][0]["id"] = json!("Ada");
    case_duplicate["participants"][1]["id"] = json!("ada");
    case_duplicate["contributions"][1]["participantId"] = json!("Ada");
    case_duplicate["reveals"][0]["participantIds"] = json!(["Ada", "ada"]);
    case_duplicate["approvals"][1]["participantId"] = json!("Ada");

    let mut case_duplicate_contribution = populated_contract();
    case_duplicate_contribution["contributions"][0]["id"] = json!("C0");
    case_duplicate_contribution["reveals"][0]["contributionId"] = json!("C0");
    case_duplicate_contribution["layout"][1]["contributionId"] = json!("C0");

    let mut removed = populated_contract();
    removed["participants"] = json!([
        { "id": "p0", "displayName": "First" },
        { "id": "p1", "displayName": "Second" }
    ]);

    for invalid in [
        duplicate,
        case_duplicate,
        case_duplicate_contribution,
        removed,
    ] {
        let error = CollaborationContract::from_json(&invalid.to_string())
            .expect_err("invalid relationship must fail closed");
        assert_eq!(error.to_string(), "invalid collaboration contract");
        assert!(!error.to_string().contains("p2"));
    }
}

#[test]
fn untrusted_fields_identifiers_urls_and_markdown_are_bounded() {
    assert_eq!(MAX_PARTICIPANTS, 100);
    assert_eq!(MAX_CONTRACT_BYTES, 256 * 1024);
    assert_eq!(MAX_MARKDOWN_BYTES, 64 * 1024);

    let mut fixtures = Vec::new();

    let mut token = contract_with(&["p0"]);
    token["token"] = json!("participant-secret");
    fixtures.push(token);

    let mut metadata = contract_with(&["p0"]);
    metadata["participants"][0]["metadata"] = json!({ "private": "other-user-data" });
    fixtures.push(metadata);

    let mut unsafe_url = contract_with(&["p0"]);
    unsafe_url["participants"][0]["profileUrl"] = json!("javascript:alert(1)");
    fixtures.push(unsafe_url);

    // Each identity defect stands alone so either rule is shown to reject by itself.
    fixtures.push(contract_with(&["../p0"]));

    let mut nul_name = contract_with(&["p0"]);
    nul_name["participants"][0]["displayName"] = json!("Participant\u{0}name");
    fixtures.push(nul_name);

    let mut oversized_markdown = populated_contract();
    oversized_markdown["contributions"][0]["markdown"] = json!("x".repeat(MAX_MARKDOWN_BYTES + 1));
    fixtures.push(oversized_markdown);

    for invalid in fixtures {
        let error = CollaborationContract::from_json(&invalid.to_string())
            .expect_err("untrusted contract must fail closed");
        assert_eq!(error.to_string(), "invalid collaboration contract");
        assert!(!error.to_string().contains("participant-secret"));
        assert!(!error.to_string().contains("other-user-data"));
    }
}

#[test]
fn identifiers_reject_dot_segments_and_non_ascii_lookalikes() {
    for id in [".", "..", ".p0", "p0.", "p..0", "p\u{0430}0", "p0 ", "P/0"] {
        let error = CollaborationContract::from_json(&contract_with(&[id]).to_string())
            .expect_err("unsafe identifier must fail closed");
        assert_eq!(error.to_string(), "invalid collaboration contract");
    }

    let mut region = populated_contract();
    region["layout"][0]["region"] = json!("..");
    assert!(CollaborationContract::from_json(&region.to_string()).is_err());

    // Windows device names cannot be opened as ordinary files, whatever their case or extension.
    for id in ["con", "PRN", "Aux", "nul.json", "com1", "LPT9.p0", "com0"] {
        assert!(
            CollaborationContract::from_json(&contract_with(&[id]).to_string()).is_err(),
            "{id}"
        );
        let mut region = populated_contract();
        region["layout"][0]["region"] = json!(id);
        assert!(
            CollaborationContract::from_json(&region.to_string()).is_err(),
            "{id}"
        );
    }

    for id in [
        "p0",
        "ada.lovelace",
        "Guest_2",
        "a-b",
        "console",
        "com10",
        "my.con",
    ] {
        CollaborationContract::from_json(&contract_with(&[id]).to_string())
            .expect("opaque ASCII identifier remains valid");
    }
}

#[test]
fn display_names_keep_unicode_but_reject_spoofing_controls() {
    for name in [
        "Zoë 李",
        "Ada 👩\u{200D}💻",
        "مریم\u{200C}ی",
        "  Grace  ",
        "Ada ❤\u{FE0F}",
        "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
        "한글",
    ] {
        let mut contract = contract_with(&["p0"]);
        contract["participants"][0]["displayName"] = json!(name);
        let parsed = CollaborationContract::from_json(&contract.to_string())
            .expect("Unicode display name is valid");
        assert_eq!(parsed.participants[0].display_name, name);
    }

    for name in [
        "Ada\u{202E}nimda",
        "\u{2067}Grace",
        "\u{200B}",
        "\u{FEFF}\u{2060}",
        "\u{3000}",
        "Ada\nAdmin",
        "Ada\u{2028}Admin",
        "Ada\u{2029}Admin",
        "\u{00AD}",
        "\u{034F}",
        "\u{115F}\u{1160}",
        "\u{17B4}",
        "\u{180E}",
        "\u{3164}",
        "\u{FFA0}",
        "\u{2800}",
        "\u{FE0F}",
        "\u{1D159}",
        "\u{1D173}",
        "\u{E0041}\u{E0042}",
    ] {
        let mut contract = contract_with(&["p0"]);
        contract["participants"][0]["displayName"] = json!(name);
        let error = CollaborationContract::from_json(&contract.to_string())
            .expect_err("spoofing display name must fail closed");
        assert_eq!(error.to_string(), "invalid collaboration contract");
    }
}

#[test]
fn profile_urls_are_absolute_https_without_credentials_or_bad_ports() {
    for url in [
        "https://example.org/ada",
        "https://example.org:8443/ada?tab=work#bio",
        "https://xn--exmple-cua.org/",
    ] {
        let mut contract = contract_with(&["p0"]);
        contract["participants"][0]["profileUrl"] = json!(url);
        CollaborationContract::from_json(&contract.to_string()).expect("safe profile URL");
    }

    for url in [
        "http://example.org/ada",
        "//example.org/ada",
        "/contributors/ada",
        "https://user:secret@example.org/",
        "https://example.org:99999/",
        "https://example.org:/",
        "https://exämple.org/",
        "https://example..org/",
        "data:text/html,<script>alert(1)</script>",
        "https://example.org/\u{202E}",
    ] {
        let mut contract = contract_with(&["p0"]);
        contract["participants"][0]["profileUrl"] = json!(url);
        let error = CollaborationContract::from_json(&contract.to_string())
            .expect_err("unsafe profile URL must fail closed");
        assert!(!error.to_string().contains("example"));
    }
}

#[test]
fn pair_projection_exists_only_for_two_ordered_participants() {
    for count in [1, 3, 10] {
        let ids = (0..count)
            .map(|index| format!("p{index}"))
            .collect::<Vec<_>>();
        let borrowed = ids.iter().map(String::as_str).collect::<Vec<_>>();
        let contract = CollaborationContract::from_json(&contract_with(&borrowed).to_string())
            .expect("valid group contract");
        assert!(contract.pair_projection().is_none());
    }

    let contract = CollaborationContract::from_json(&contract_with(&["guest", "lead"]).to_string())
        .expect("reordered pair");
    let pair = contract.pair_projection().expect("pair projection");
    assert_eq!(
        [pair.first.id.as_str(), pair.second.id.as_str()],
        ["guest", "lead"]
    );
    assert_eq!(
        serde_json::to_value(&contract).unwrap(),
        contract_with(&["guest", "lead"]),
        "projecting a pair adds no persisted state"
    );
}

#[test]
fn removed_and_reordered_participants_revalidate_every_reference() {
    let mut removed = populated_contract();
    removed["participants"] = json!([
        { "id": "p0", "displayName": "First" },
        { "id": "p1", "displayName": "Second" }
    ]);
    removed["contributions"] = json!([{ "id": "c0", "participantId": "p0", "markdown": "First" }]);
    removed["reveals"] = json!([]);
    removed["layout"] = json!([{ "contributionId": "c0", "region": "opening" }]);
    removed["approvals"] = json!([{ "participantId": "p0", "revision": 4 }]);
    let contract = CollaborationContract::from_json(&removed.to_string())
        .expect("removal that purges every reference stays valid");
    assert_eq!(contract.participants.len(), 2);

    for collection in ["contributions", "reveals", "layout", "approvals"] {
        let mut dangling = removed.clone();
        dangling[collection] = populated_contract()[collection].clone();
        let error = CollaborationContract::from_json(&dangling.to_string())
            .expect_err("reference to removed participant data fails closed");
        assert_eq!(
            error.to_string(),
            "invalid collaboration contract",
            "{collection}"
        );
    }

    let mut reordered = populated_contract();
    let participants = reordered["participants"].as_array_mut().unwrap();
    participants.reverse();
    let contract =
        CollaborationContract::from_json(&reordered.to_string()).expect("reordered group");
    assert_eq!(contract.participants[0].id, "p2");
    assert_eq!(contract.contributions[0].participant_id, "p2");
    assert_eq!(contract.reveals[0].participant_ids, ["p0", "p1"]);
}

#[test]
fn duplicate_entries_in_every_collection_fail_closed() {
    let mut fixtures = Vec::new();
    for (collection, entry) in [
        (
            "contributions",
            json!({ "id": "c0", "participantId": "p1", "markdown": "Again" }),
        ),
        (
            "reveals",
            json!({ "contributionId": "c0", "participantIds": ["p1"] }),
        ),
        (
            "layout",
            json!({ "contributionId": "c0", "region": "closing" }),
        ),
        ("approvals", json!({ "participantId": "p0", "revision": 4 })),
    ] {
        let mut duplicate = populated_contract();
        duplicate[collection].as_array_mut().unwrap().push(entry);
        fixtures.push(duplicate.to_string());
    }
    let mut repeated_viewer = populated_contract();
    repeated_viewer["reveals"][0]["participantIds"] = json!(["p0", "p0"]);
    fixtures.push(repeated_viewer.to_string());
    let mut empty_reveal = populated_contract();
    empty_reveal["reveals"][0]["participantIds"] = json!([]);
    fixtures.push(empty_reveal.to_string());
    fixtures.push(
        r#"{"version":1,"revision":4,"participants":[{"id":"p0","id":"p1","displayName":"A"}],"contributions":[],"reveals":[],"layout":[],"approvals":[]}"#
            .to_string(),
    );
    let mut empty_group = contract_with(&[]);
    empty_group["revision"] = json!(4);
    fixtures.push(empty_group.to_string());

    for fixture in fixtures {
        let error = CollaborationContract::from_json(&fixture).expect_err("duplicate fails");
        assert_eq!(error.to_string(), "invalid collaboration contract");
    }
}

#[test]
fn collection_and_text_limits_are_enforced_at_their_boundaries() {
    let ids = (0..=MAX_PARTICIPANTS)
        .map(|index| format!("p{index}"))
        .collect::<Vec<_>>();
    let borrowed = ids.iter().map(String::as_str).collect::<Vec<_>>();
    CollaborationContract::from_json(&contract_with(&borrowed[..MAX_PARTICIPANTS]).to_string())
        .expect("maximum group size is accepted");
    assert!(CollaborationContract::from_json(&contract_with(&borrowed).to_string()).is_err());

    let contributions = |count: usize| {
        let mut contract = contract_with(&["p0"]);
        contract["contributions"] = (0..count)
            .map(
                |index| json!({ "id": format!("c{index}"), "participantId": "p0", "markdown": "" }),
            )
            .collect();
        contract
    };
    CollaborationContract::from_json(&contributions(MAX_CONTRIBUTIONS).to_string())
        .expect("maximum contributions are accepted");
    assert!(
        CollaborationContract::from_json(&contributions(MAX_CONTRIBUTIONS + 1).to_string())
            .is_err()
    );

    // Reveal and layout entries each name a distinct contribution, so their own caps are
    // reached together with the contribution cap and the whole set still fits the byte cap.
    assert_eq!(MAX_REVEALS, MAX_CONTRIBUTIONS);
    assert_eq!(MAX_LAYOUT_ITEMS, MAX_CONTRIBUTIONS);
    let mut full = contributions(MAX_CONTRIBUTIONS);
    full["reveals"] = (0..MAX_REVEALS)
        .map(|index| json!({ "contributionId": format!("c{index}"), "participantIds": ["p0"] }))
        .collect();
    full["layout"] = (0..MAX_LAYOUT_ITEMS)
        .map(|index| json!({ "contributionId": format!("c{index}"), "region": "body" }))
        .collect();
    assert!(full.to_string().len() < MAX_CONTRACT_BYTES);
    CollaborationContract::from_json(&full.to_string())
        .expect("every collection at its maximum is accepted");

    // Approvals are capped at one per participant, so the largest group can all approve.
    let mut approved = contract_with(&borrowed[..MAX_PARTICIPANTS]);
    approved["approvals"] = borrowed[..MAX_APPROVALS]
        .iter()
        .map(|id| json!({ "participantId": id, "revision": 4 }))
        .collect();
    CollaborationContract::from_json(&approved.to_string())
        .expect("maximum group with every approval is accepted");

    let region = |bytes: usize| {
        let mut contract = populated_contract();
        contract["layout"][0]["region"] = json!("r".repeat(bytes));
        contract.to_string()
    };
    CollaborationContract::from_json(&region(MAX_REGION_BYTES))
        .expect("maximum region length is accepted");
    assert!(CollaborationContract::from_json(&region(MAX_REGION_BYTES + 1)).is_err());

    let markdown = |bytes: usize| {
        let mut contract = populated_contract();
        contract["contributions"][0]["markdown"] = json!("x".repeat(bytes));
        contract.to_string()
    };
    CollaborationContract::from_json(&markdown(MAX_MARKDOWN_BYTES))
        .expect("maximum Markdown length is accepted");
    assert!(CollaborationContract::from_json(&markdown(MAX_MARKDOWN_BYTES + 1)).is_err());

    let long_id = "p".repeat(MAX_IDENTIFIER_BYTES);
    CollaborationContract::from_json(&contract_with(&[&long_id]).to_string())
        .expect("maximum identifier length is accepted");
    let too_long_id = "p".repeat(MAX_IDENTIFIER_BYTES + 1);
    assert!(CollaborationContract::from_json(&contract_with(&[&too_long_id]).to_string()).is_err());

    let mut name = contract_with(&["p0"]);
    name["participants"][0]["displayName"] = json!("é".repeat(MAX_DISPLAY_NAME_BYTES / 2));
    CollaborationContract::from_json(&name.to_string())
        .expect("maximum display-name length is accepted");
    name["participants"][0]["displayName"] = json!("é".repeat(MAX_DISPLAY_NAME_BYTES / 2 + 1));
    assert!(
        CollaborationContract::from_json(&name.to_string()).is_err(),
        "limits count UTF-8 bytes, not characters"
    );

    let url = |bytes: usize| {
        let prefix = "https://example.org/";
        let mut contract = contract_with(&["p0"]);
        contract["participants"][0]["profileUrl"] =
            json!(format!("{prefix}{}", "a".repeat(bytes - prefix.len())));
        contract.to_string()
    };
    CollaborationContract::from_json(&url(MAX_PROFILE_URL_BYTES))
        .expect("maximum profile URL length is accepted");
    assert!(CollaborationContract::from_json(&url(MAX_PROFILE_URL_BYTES + 1)).is_err());

    let oversized = format!(
        "{}{}",
        contract_with(&["p0"]),
        " ".repeat(MAX_CONTRACT_BYTES)
    );
    assert!(CollaborationContract::from_json(&oversized).is_err());
}

#[test]
fn hostile_markdown_is_retained_verbatim_as_untrusted_source() {
    let hostile =
        "<script>alert('p1')</script>\n[x](javascript:alert(1))\n# Zoë {#dup}\n# Zoë {#dup}";
    let mut contract = populated_contract();
    contract["contributions"][0]["markdown"] = json!(hostile);
    let parsed = CollaborationContract::from_json(&contract.to_string()).expect("valid source");
    assert_eq!(parsed.contributions[0].markdown, hostile);

    contract["contributions"][0]["markdown"] = json!(format!("{hostile}\u{0}"));
    let error = CollaborationContract::from_json(&contract.to_string()).expect_err("NUL fails");
    assert!(!error.to_string().contains("script"));
}

#[test]
fn concurrent_replacement_is_atomic_and_revision_checked() {
    let current = CollaborationContract::from_json(&contract_with(&["p0", "p1"]).to_string())
        .expect("current contract");
    let mut replacement = contract_with(&["p1", "p0", "p2"]);
    replacement["revision"] = json!(5);

    let updated = current
        .replace_from_json(&replacement.to_string(), 4)
        .expect("matching revision replaces the whole contract");
    assert_eq!(updated.revision, 5);
    assert_eq!(updated.participants[0].id, "p1");

    let snapshot = current.clone();
    let mut skipped = replacement.clone();
    skipped["revision"] = json!(7);
    let mut carried_approval = populated_contract();
    carried_approval["revision"] = json!(5);
    let mut malformed = replacement.to_string();
    malformed.truncate(malformed.len() / 2);
    for (source, observed) in [
        (replacement.to_string(), 3),
        (replacement.to_string(), 5),
        (skipped.to_string(), 4),
        (carried_approval.to_string(), 4),
        (contract_with(&["p0", "p1"]).to_string(), 4),
        (malformed, 4),
    ] {
        let error = current
            .replace_from_json(&source, observed)
            .expect_err("stale, replayed, skipped, or invalid replacement must fail");
        assert_eq!(error.to_string(), "invalid collaboration contract");
        assert_eq!(
            current, snapshot,
            "failed replacement leaves state unchanged"
        );
    }

    let mut exhausted = contract_with(&["p0"]);
    exhausted["revision"] = json!(u64::MAX);
    let exhausted = CollaborationContract::from_json(&exhausted.to_string()).unwrap();
    assert!(exhausted
        .replace_from_json(&contract_with(&["p0"]).to_string(), u64::MAX)
        .is_err());
}
