use openblog_core::collaboration::{
    AuthorizationAction, AuthorizationContext, AuthorizationRole, AuthorizationTarget,
    NewParticipant, NewSharedPublication, NewSourceReference, SharedPublication,
    SharedPublicationError, SourceField, SourceKind, SourceProvenance, MAX_GUIDING_QUESTION_BYTES,
    MAX_PUBLICATION_TITLE_BYTES, MAX_SHARED_PUBLICATION_BYTES, MAX_SOURCES, MAX_SOURCE_URL_BYTES,
};
use serde_json::{json, Value};

fn ada() -> NewParticipant {
    NewParticipant {
        admin_user: "ada-admin".into(),
        contributor_id: "ada".into(),
        display_name: "Ada Lovelace".into(),
    }
}

fn source(kind: SourceKind, title: &str, url: &str) -> NewSourceReference {
    NewSourceReference {
        kind,
        title: title.into(),
        url: url.into(),
        ..NewSourceReference::default()
    }
}

fn new_publication(sources: Vec<NewSourceReference>) -> NewSharedPublication {
    NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "On attention".into(),
        guiding_question: "What does attention ask of us?".into(),
        sources,
        creator: ada(),
    }
}

fn video() -> NewSourceReference {
    source(
        SourceKind::Video,
        "The Art of Noticing",
        "https://www.youtube.com/watch?v=abc123",
    )
}

fn create(sources: Vec<NewSourceReference>) -> Result<SharedPublication, SharedPublicationError> {
    SharedPublication::create(&new_publication(sources))
}

fn record_json(record: &SharedPublication) -> Value {
    serde_json::to_value(record).unwrap()
}

#[test]
fn one_or_many_sources_keep_authored_order_and_stable_ids() {
    let one = create(vec![video()]).expect("one source");
    assert_eq!(one.sources.len(), 1);
    assert_eq!(one.sources[0].id, "source-1");
    assert_eq!(one.sources[0].kind, SourceKind::Video);
    assert_eq!(one.sources[0].provenance, SourceProvenance::Author);

    let many = create(vec![
        source(SourceKind::Podcast, "Episode 12", "https://example.org/12"),
        NewSourceReference {
            kind: SourceKind::Book,
            title: "Middlemarch".into(),
            creator: "George Eliot".into(),
            publisher: "Blackwood".into(),
            published: "1871".into(),
            isbn: "978-0-14-143954-9".into(),
            ..NewSourceReference::default()
        },
        source(SourceKind::Article, "A reply", "http://example.com/reply"),
    ])
    .expect("many sources");
    let ids = many
        .sources
        .iter()
        .map(|source| (source.id.as_str(), source.title.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            ("source-1", "Episode 12"),
            ("source-2", "Middlemarch"),
            ("source-3", "A reply")
        ]
    );

    let reloaded = SharedPublication::from_json(&serde_json::to_string(&many).unwrap())
        .expect("a created record reloads");
    assert_eq!(reloaded, many);
}

#[test]
fn a_shared_publication_needs_at_least_one_source() {
    assert_eq!(create(Vec::new()), Err(SharedPublicationError::NoSources));
    let mut stored = record_json(&create(vec![video()]).unwrap());
    stored["sources"] = json!([]);
    assert_eq!(
        SharedPublication::from_json(&stored.to_string()),
        Err(SharedPublicationError::InvalidRecord)
    );
    let too_many = (0..=MAX_SOURCES).map(|_| video()).collect();
    assert_eq!(
        create(too_many),
        Err(SharedPublicationError::TooManySources)
    );
    let at_limit = (0..MAX_SOURCES).map(|_| video()).collect();
    assert!(create(at_limit).is_ok());
}

#[test]
fn a_title_or_a_guiding_question_is_enough() {
    let mut only_question = new_publication(vec![video()]);
    only_question.title = "   ".into();
    let record = SharedPublication::create(&only_question).unwrap();
    assert_eq!(record.title, None);
    assert_eq!(
        record.guiding_question.as_deref(),
        Some("What does attention ask of us?")
    );

    let mut only_title = new_publication(vec![video()]);
    only_title.guiding_question.clear();
    let record = SharedPublication::create(&only_title).unwrap();
    assert_eq!(record.title.as_deref(), Some("On attention"));
    assert_eq!(record.guiding_question, None);

    let mut neither = new_publication(vec![video()]);
    neither.title.clear();
    neither.guiding_question = "\t".into();
    assert_eq!(
        SharedPublication::create(&neither),
        Err(SharedPublicationError::TitleOrQuestionRequired)
    );
}

#[test]
fn sources_without_a_link_keep_structured_manual_metadata() {
    let record = create(vec![
        NewSourceReference {
            kind: SourceKind::Book,
            title: "  The Practice of the Wild ".into(),
            creator: "Gary Snyder".into(),
            publisher: "North Point Press".into(),
            published: "1990".into(),
            isbn: "0-86547-454-X".into(),
            ..NewSourceReference::default()
        },
        source(SourceKind::Other, "A conversation at the river", ""),
    ])
    .unwrap();
    let book = &record.sources[0];
    assert_eq!(book.title, "The Practice of the Wild");
    assert_eq!(book.url, None);
    assert_eq!(book.creator.as_deref(), Some("Gary Snyder"));
    assert_eq!(book.publisher.as_deref(), Some("North Point Press"));
    assert_eq!(book.published.as_deref(), Some("1990"));
    assert_eq!(book.isbn.as_deref(), Some("0-86547-454-X"));
    assert_eq!(record.sources[1].url, None);
    assert_eq!(record.sources[1].creator, None);

    let stored = record_json(&record);
    assert_eq!(stored["sources"][0]["kind"], "book");
    assert_eq!(stored["sources"][0]["provenance"], "author");
    assert!(stored["sources"][1].get("url").is_none());

    for isbn in [
        "12345",
        "978-0-14-143954-9X",
        "ISBN 0-86547-454-X",
        "X865474549",
    ] {
        let mut book = source(SourceKind::Book, "Book", "");
        book.isbn = isbn.into();
        assert_eq!(
            create(vec![book]),
            Err(SharedPublicationError::Source {
                index: 0,
                field: SourceField::Isbn
            }),
            "{isbn}"
        );
    }
    let mut not_a_book = source(SourceKind::Video, "Talk", "");
    not_a_book.isbn = "0-86547-454-X".into();
    assert_eq!(
        create(vec![video(), not_a_book]),
        Err(SharedPublicationError::Source {
            index: 1,
            field: SourceField::Isbn
        })
    );
}

#[test]
fn http_and_https_links_are_normalized_including_unicode_hosts_and_paths() {
    let record = create(vec![
        source(SourceKind::Article, "Plain", "  HTTPS://Example.org  "),
        source(
            SourceKind::Article,
            "Insecure",
            "http://example.com/a b?q=1#part",
        ),
        source(
            SourceKind::Article,
            "Unicode",
            "https://bücher.example/straße/über",
        ),
        source(SourceKind::Article, "Port", "https://example.org:8443/x"),
    ])
    .unwrap();
    let urls = record
        .sources
        .iter()
        .map(|source| source.url.as_deref().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        urls,
        [
            "https://example.org/",
            "http://example.com/a%20b?q=1#part",
            "https://xn--bcher-kva.example/stra%C3%9Fe/%C3%BCber",
            "https://example.org:8443/x",
        ]
    );
}

#[test]
fn unsafe_schemes_credentials_and_malformed_links_are_refused() {
    let long = format!("https://example.org/{}", "a".repeat(MAX_SOURCE_URL_BYTES));
    for url in [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "java\nscript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "ftp://example.org/file",
        "mailto:ada@example.org",
        "//example.org/path",
        "/relative/path",
        "example.org",
        "https://",
        "https://ada:secret@example.org/",
        "https://token@example.org/",
        "https://example.org:99999/",
        "https://exa mple.org/",
        "https://example..org/",
        "https://example.org/\u{202E}gpj.exe",
        "https://example.org/\u{0}",
        long.as_str(),
    ] {
        assert_eq!(
            create(vec![source(SourceKind::Article, "Link", url)]),
            Err(SharedPublicationError::Source {
                index: 0,
                field: SourceField::Url
            }),
            "{url:?}"
        );
    }

    // A stored record is held to the same rule without normalization.
    let mut stored = record_json(&create(vec![video()]).unwrap());
    for url in [
        "javascript:alert(1)",
        "https://bücher.example/",
        "https://ada:secret@example.org/",
        "/relative",
    ] {
        stored["sources"][0]["url"] = json!(url);
        assert_eq!(
            SharedPublication::from_json(&stored.to_string()),
            Err(SharedPublicationError::InvalidRecord),
            "{url}"
        );
    }
}

#[test]
fn text_keeps_unicode_but_rejects_spoofing_blank_and_oversized_values() {
    let mut unicode = new_publication(vec![source(
        SourceKind::Video,
        "聴くこと — Über das Zuhören 🎧",
        "",
    )]);
    unicode.title = "مشاهدة معًا".into();
    unicode.guiding_question = "Qu’est-ce qui a changé ? 👩🏽‍🔬".into();
    unicode.creator.display_name = "Grace 🇺🇸".into();
    let record = SharedPublication::create(&unicode).unwrap();
    assert_eq!(record.sources[0].title, "聴くこと — Über das Zuhören 🎧");
    assert_eq!(
        record.collaboration.participants[0].display_name,
        "Grace 🇺🇸"
    );

    for hostile in [
        "Evil\u{202E}txt.exe",
        "Line\nbreak",
        "\u{200B}\u{3164}",
        "Nul\0",
    ] {
        let mut title = new_publication(vec![video()]);
        title.title = hostile.into();
        assert_eq!(
            SharedPublication::create(&title),
            Err(SharedPublicationError::Title),
            "{hostile:?}"
        );
        let mut question = new_publication(vec![video()]);
        question.guiding_question = hostile.into();
        assert_eq!(
            SharedPublication::create(&question),
            Err(SharedPublicationError::GuidingQuestion)
        );
        assert_eq!(
            create(vec![source(SourceKind::Video, hostile, "")]),
            Err(SharedPublicationError::Source {
                index: 0,
                field: SourceField::Title
            })
        );
        let mut creator = source(SourceKind::Video, "Talk", "");
        creator.creator = hostile.into();
        assert_eq!(
            create(vec![creator]),
            Err(SharedPublicationError::Source {
                index: 0,
                field: SourceField::Creator
            })
        );
    }
    assert_eq!(
        create(vec![source(SourceKind::Video, " ", "")]),
        Err(SharedPublicationError::Source {
            index: 0,
            field: SourceField::Title
        })
    );

    let mut long_title = new_publication(vec![video()]);
    long_title.title = "é".repeat(MAX_PUBLICATION_TITLE_BYTES / 2 + 1);
    assert_eq!(
        SharedPublication::create(&long_title),
        Err(SharedPublicationError::Title)
    );
    long_title.title = "é".repeat(MAX_PUBLICATION_TITLE_BYTES / 2);
    assert!(SharedPublication::create(&long_title).is_ok());
    let mut long_question = new_publication(vec![video()]);
    long_question.guiding_question = "q".repeat(MAX_GUIDING_QUESTION_BYTES + 1);
    assert_eq!(
        SharedPublication::create(&long_question),
        Err(SharedPublicationError::GuidingQuestion)
    );
}

#[test]
fn the_creator_is_bound_as_the_first_site_owner_without_drafts_or_credit() {
    let record = create(vec![video()]).unwrap();
    assert_eq!(record.version, 1);
    assert_eq!(record.publication_id, "shared-0a1b2c3d4e5f");
    assert_eq!(
        record.authorization.publication_id, record.publication_id,
        "the record ties the policy and contract to one publication"
    );
    let participant = &record.collaboration.participants[0];
    assert_eq!(record.collaboration.participants.len(), 1);
    assert_eq!(participant.display_name, "Ada Lovelace");
    assert_eq!(participant.profile_url, None);
    assert!(record.collaboration.contributions.is_empty());
    assert!(record.collaboration.reveals.is_empty());
    assert!(record.collaboration.approvals.is_empty());
    assert_eq!(record.collaboration.revision, 1);
    assert_eq!(record.authorization.revision, 1);

    let binding = &record.authorization.bindings[0];
    assert_eq!(binding.admin_user, "ada-admin");
    assert_eq!(binding.contributor_id, "ada");
    assert_eq!(binding.participant_id, participant.id);
    assert_eq!(
        binding.roles,
        [AuthorizationRole::SiteOwner, AuthorizationRole::Contributor]
    );

    // Group-safe: the record has no pair-shaped or credit-shaped keys.
    let text = serde_json::to_string(&record).unwrap().to_ascii_lowercase();
    for forbidden in [
        "\"left",
        "\"right",
        "authora",
        "authorb",
        "\"credits\":",
        "\"author\":",
    ] {
        assert!(!text.contains(forbidden), "{forbidden}");
    }

    for creator in [
        NewParticipant {
            admin_user: "Ada-Admin".into(),
            ..ada()
        },
        NewParticipant {
            contributor_id: "Ada".into(),
            ..ada()
        },
        NewParticipant {
            display_name: "\u{202E}adA".into(),
            ..ada()
        },
    ] {
        let mut request = new_publication(vec![video()]);
        request.creator = creator;
        assert_eq!(
            SharedPublication::create(&request),
            Err(SharedPublicationError::Creator)
        );
    }
}

#[test]
fn stored_records_reject_duplicates_unknown_fields_and_mismatched_parts() {
    let valid = record_json(
        &create(vec![
            video(),
            source(SourceKind::Article, "Second", "https://example.org/2"),
        ])
        .unwrap(),
    );
    assert!(SharedPublication::from_json(&valid.to_string()).is_ok());

    let mut cases = Vec::new();
    let mut duplicate = valid.clone();
    duplicate["sources"][1]["id"] = json!("source-1");
    cases.push(("duplicate source id", duplicate));
    let mut case_collision = valid.clone();
    case_collision["sources"][1]["id"] = json!("Source-1");
    cases.push(("case-colliding source id", case_collision));
    let mut traversal = valid.clone();
    traversal["sources"][0]["id"] = json!("../source");
    cases.push(("unsafe source id", traversal));
    let mut unknown = valid.clone();
    unknown["sessionToken"] = json!("secret");
    cases.push(("unknown record field", unknown));
    let mut unknown_source = valid.clone();
    unknown_source["sources"][0]["transcript"] = json!("Private transcript");
    cases.push(("unknown source field", unknown_source));
    let mut provider = valid.clone();
    provider["sources"][0]["provenance"] = json!("provider");
    cases.push(("unsupported provenance", provider));
    let mut kind = valid.clone();
    kind["sources"][0]["kind"] = json!("tweet");
    cases.push(("unknown source kind", kind));
    let mut version = valid.clone();
    version["version"] = json!(2);
    cases.push(("future version", version));
    let mut other_publication = valid.clone();
    other_publication["authorization"]["publicationId"] = json!("someone-else");
    cases.push(("policy for another publication", other_publication));
    let mut bad_contract = valid.clone();
    bad_contract["collaboration"]["participants"] = json!([]);
    cases.push(("invalid nested contract", bad_contract));
    let mut bad_policy = valid.clone();
    bad_policy["authorization"]["bindings"][0]["roles"] = json!([]);
    cases.push(("invalid nested policy", bad_policy));
    let mut neither = valid.clone();
    neither.as_object_mut().unwrap().remove("title");
    neither.as_object_mut().unwrap().remove("guidingQuestion");
    cases.push(("no title or question", neither));
    let mut id = valid.clone();
    id["publicationId"] = json!("con");
    id["authorization"]["publicationId"] = json!("con");
    cases.push(("device-name publication id", id));

    for (name, case) in cases {
        let error = SharedPublication::from_json(&case.to_string())
            .expect_err(&format!("{name} must be rejected"));
        assert_eq!(error, SharedPublicationError::InvalidRecord, "{name}");
    }

    let oversized = format!(
        "{}{}",
        valid,
        " ".repeat(MAX_SHARED_PUBLICATION_BYTES + 1 - valid.to_string().len())
    );
    assert_eq!(
        SharedPublication::from_json(&oversized),
        Err(SharedPublicationError::InvalidRecord)
    );
}

#[test]
fn errors_never_echo_submitted_values() {
    let secret = "https://ada:hunter2@example.org/private-draft";
    let error = create(vec![source(SourceKind::Article, "Leak?", secret)]).unwrap_err();
    let message = error.to_string();
    assert!(!message.contains("hunter2") && !message.contains("private-draft"));
    assert_eq!(message, "source 1 has an invalid link");

    let mut stored = record_json(&create(vec![video()]).unwrap());
    stored["sources"][0]["title"] = json!("Private reflection\u{202E}");
    let message = SharedPublication::from_json(&stored.to_string())
        .unwrap_err()
        .to_string();
    assert_eq!(message, "invalid shared publication record");
}

#[test]
fn hostile_markup_is_kept_verbatim_as_untrusted_text() {
    let hostile = "<script>alert(1)</script> **bold** [x](javascript:alert(1))";
    let mut request = new_publication(vec![source(SourceKind::Article, hostile, "")]);
    request.guiding_question = hostile.into();
    let record = SharedPublication::create(&request).unwrap();
    assert_eq!(record.sources[0].title, hostile);
    assert_eq!(record.guiding_question.as_deref(), Some(hostile));
}

#[test]
fn bound_participants_may_view_the_publication_and_others_may_not() {
    let record = create(vec![video()]).unwrap();
    let context = |admin_user| AuthorizationContext {
        publication_id: "shared-0a1b2c3d4e5f",
        authenticated_admin_user: admin_user,
        active_admin_users: &["ada-admin", "grace-admin"],
        contributor_ids: &["ada", "grace"],
        collaboration: &record.collaboration,
        target: AuthorizationTarget::Publication,
    };
    assert!(record
        .authorization
        .authorize(&context("ada-admin"), AuthorizationAction::ViewPublication)
        .is_ok());
    assert!(record
        .authorization
        .authorize(
            &context("grace-admin"),
            AuthorizationAction::ViewPublication
        )
        .is_err());
}

#[test]
fn removing_an_admin_user_revokes_their_bindings_and_advances_the_policy() {
    let record = create(vec![video()]).unwrap();
    assert_eq!(record.without_admin_user("grace-admin"), None);
    let revoked = record
        .without_admin_user("ada-admin")
        .expect("ada's binding is removed");
    assert!(revoked.authorization.bindings.is_empty());
    assert_eq!(revoked.authorization.revision, 2);
    assert_eq!(revoked.collaboration, record.collaboration);
    assert_eq!(revoked.sources, record.sources);
    let reloaded = SharedPublication::from_json(&serde_json::to_string(&revoked).unwrap()).unwrap();
    assert_eq!(reloaded, revoked);
}
