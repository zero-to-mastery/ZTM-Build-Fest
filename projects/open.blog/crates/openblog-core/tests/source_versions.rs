//! Editions, translations, witnesses, rights declarations, attribution
//! uncertainty, and attributed interpretations in the source library
//! (ADR 0084–0087).

use std::collections::BTreeMap;

use openblog_core::citations::public_reference;
use openblog_core::contributor::Contributor;
use openblog_core::interpretation::{Interpretation, InterpretationKind, InterpreterIdentity};
use openblog_core::source_interchange::{
    export_bibtex, export_csl_json, plan_csl_import, ImportAction,
};
use openblog_core::source_library::{
    AttributionCertainty, ResearchSourceKind, RightsStatus, SourceDiagnostic, SourceDiagnosticCode,
    SourceLibrary, SourceRecord,
};
use serde_json::{json, Value};

const VERSIONS: &str = r#"{
  "version": 1,
  "sources": [
    {"id": "plato-republic", "kind": "work", "title": "Πολιτεία", "language": "grc",
     "creators": [{"name": "Plato", "role": "author", "attribution": "stated"}]},
    {"id": "burnet-1900", "kind": "edition", "of": "plato-republic",
     "title": "Platonis Opera", "issued": "1900–1907", "volumes": 5,
     "creators": [{"name": "John Burnet", "role": "editor"}],
     "rights": {"status": "publicDomain", "note": "Published 1900–1907; the editor died in 1928", "checked": "2026-10"}},
    {"id": "burnet-1902", "kind": "edition", "of": "plato-republic", "revises": "burnet-1900",
     "title": "Platonis Opera, corrected impression", "volumes": 5},
    {"id": "republic-grube-reeve", "kind": "translation", "of": "plato-republic",
     "basedOn": "burnet-1902", "language": "en", "title": "Republic",
     "creators": [{"name": "G. M. A. Grube", "role": "translator"},
                  {"name": "C. D. C. Reeve", "role": "translator", "note": "Revised the 1974 translation"}],
     "rights": {"status": "rightsReserved", "note": "Hackett, 1992"}},
    {"id": "republic-grube-reeve-1992", "kind": "edition", "of": "republic-grube-reeve",
     "title": "Plato: Republic", "issued": "1992"},
    {"id": "paris-gr-1807", "kind": "witness", "of": "plato-republic", "title": "Paris gr. 1807",
     "repository": "Bibliothèque nationale de France, Paris", "shelfmark": "Grec 1807",
     "anonymous": true,
     "rights": {"status": "openLicense", "license": "Licence Ouverte 2.0", "note": "Gallica images"}},
    {"id": "burnet-iv-327", "kind": "reference", "of": "burnet-1902",
     "location": {"scheme": "page", "value": "327", "volume": "4"}},
    {"id": "paris-12r", "kind": "reference", "of": "paris-gr-1807",
     "location": {"scheme": "folio", "value": "12r"}},
    {"id": "rhetorica-ad-alexandrum", "kind": "work", "title": "Rhetorica ad Alexandrum",
     "anonymous": true,
     "creators": [
       {"name": "Aristotle", "role": "author", "attribution": "disputed",
        "note": "Transmitted with Aristotle's works; many scholars assign it to Anaximenes"},
       {"name": "Anaximenes of Lampsacus", "role": "author", "attribution": "attributed"}]}
  ],
  "interpretations": [
    {"id": "cave-514a-ada", "kind": "rendering", "source": "burnet-1902",
     "locators": [{"kind": "canonical", "value": "514a"}], "language": "en",
     "text": "Next, compare our nature in its education and its lack of education\nto an experience like this.",
     "interpreters": [{"contributor": "ada"}, {"name": "Grace Hopper", "attribution": "uncertain"}],
     "rights": {"status": "ownWork"}, "draftOf": 2},
    {"id": "cave-reading-adam", "kind": "reading", "source": "plato-republic",
     "locators": [{"kind": "canonical", "value": "514a", "to": "517a"}],
     "text": "Reads the cave as an image of education rather than of politics.",
     "interpreters": [{"name": "James Adam", "attribution": "stated", "sortName": "Adam, James"}],
     "uncertainty": "Summarised from the 1902 commentary; the page is not checked yet"},
    {"id": "scholion-12r", "kind": "reading", "source": "paris-gr-1807",
     "locators": [{"kind": "folio", "value": "12r"}], "language": "grc",
     "text": "σημείωσαι", "anonymous": true,
     "interpreters": [{"name": "Arethas of Caesarea", "attribution": "disputed"}]}
  ]
}"#;

fn contributors() -> BTreeMap<String, Contributor> {
    BTreeMap::from([(
        "ada".to_string(),
        Contributor {
            name: "Ada".into(),
            ..Contributor::default()
        },
    )])
}

fn parse(text: &str) -> Result<SourceLibrary, Vec<SourceDiagnostic>> {
    SourceLibrary::parse(text, &contributors())
}

fn versions() -> SourceLibrary {
    parse(VERSIONS).expect("the fixture is a valid library")
}

/// The fixture with one JSON edit applied.
fn edited(edit: impl FnOnce(&mut Value)) -> String {
    let mut value: Value = serde_json::from_str(VERSIONS).unwrap();
    edit(&mut value);
    value.to_string()
}

fn problems(text: &str) -> Vec<(SourceDiagnosticCode, String)> {
    parse(text)
        .expect_err("the library should be refused")
        .into_iter()
        .map(|diagnostic| (diagnostic.code, diagnostic.field.unwrap_or_default()))
        .collect()
}

fn source_index(id: &str) -> usize {
    let value: Value = serde_json::from_str(VERSIONS).unwrap();
    value["sources"]
        .as_array()
        .unwrap()
        .iter()
        .position(|source| source["id"] == id)
        .unwrap()
}

#[test]
fn existing_libraries_read_and_write_exactly_as_before() {
    // A version 1 library written before this change: no new field appears,
    // nothing is inferred, and the canonical bytes are unchanged.
    let legacy = r#"{
  "version": 1,
  "sources": [
    {
      "id": "plato-republic",
      "kind": "work",
      "title": "Πολιτεία",
      "creators": [
        {
          "name": "Plato",
          "role": "author"
        }
      ]
    },
    {
      "id": "paris-gr-1807",
      "kind": "witness",
      "title": "Paris, BnF, gr. 1807",
      "of": "plato-republic",
      "identifiers": [
        {
          "scheme": "shelfmark",
          "value": "Grec 1807"
        }
      ],
      "csl": {
        "archive": "BnF",
        "archive_location": "Grec 1807",
        "number-of-volumes": 2
      }
    },
    {
      "id": "folio",
      "kind": "reference",
      "of": "paris-gr-1807",
      "location": {
        "scheme": "folio",
        "value": "12r"
      }
    }
  ]
}
"#;
    let library = SourceLibrary::parse(legacy, &BTreeMap::new()).unwrap();
    assert_eq!(
        library.to_json(),
        legacy,
        "byte-for-byte canonical round trip"
    );
    assert!(library.interpretations.is_empty());
    let witness = library.get("paris-gr-1807").unwrap();
    assert_eq!(
        witness.shelfmark, None,
        "CSL archive data is never read as witness identity"
    );
    assert_eq!(witness.volumes, None);
    assert_eq!(witness.rights_status(), Some(RightsStatus::Unknown));
    assert!(!witness.anonymous);
    assert_eq!(
        library.get("plato-republic").unwrap().creators[0].attribution,
        None,
        "an unqualified name stays unqualified"
    );
}

#[test]
fn the_full_model_round_trips_losslessly_and_deterministically() {
    let library = versions();
    let written = library.to_json();
    let reparsed = parse(&written).unwrap();
    assert_eq!(reparsed, library);
    assert_eq!(reparsed.to_json(), written);
    let original: Value = serde_json::from_str(VERSIONS).unwrap();
    let round_tripped: Value = serde_json::from_str(&written).unwrap();
    assert_eq!(
        round_tripped, original,
        "no field is lost or added, unknown ones included"
    );
    assert_eq!(library.interpretations.len(), 3);
    assert_eq!(
        library
            .get("burnet-1900")
            .unwrap()
            .rights
            .as_ref()
            .unwrap()
            .extra["checked"],
        "2026-10"
    );
}

#[test]
fn a_translation_is_never_read_as_an_edition_or_the_original_work() {
    let library = versions();
    let chain: Vec<(&str, ResearchSourceKind)> = library
        .realization_chain("republic-grube-reeve-1992")
        .into_iter()
        .map(|record| (record.id.as_str(), record.kind))
        .collect();
    assert_eq!(
        chain,
        [
            ("republic-grube-reeve-1992", ResearchSourceKind::Edition),
            ("republic-grube-reeve", ResearchSourceKind::Translation),
            ("plato-republic", ResearchSourceKind::Work),
        ],
        "an edition of a translation realizes the translation, which realizes the work"
    );

    // An edition cannot revise a translation, nor an edition of another text.
    let into_translation = edited(|v| v["sources"][2]["revises"] = json!("republic-grube-reeve"));
    assert_eq!(
        problems(&into_translation),
        [(SourceDiagnosticCode::InvalidRelationship, "revises".into())]
    );
    let across_texts = edited(|v| v["sources"][4]["revises"] = json!("burnet-1902"));
    assert_eq!(
        problems(&across_texts),
        [(
            SourceDiagnosticCode::AmbiguousRelationship,
            "revises".into()
        )]
    );
    let translation_revises = edited(|v| v["sources"][3]["revises"] = json!("burnet-1902"));
    assert!(problems(&translation_revises)
        .contains(&(SourceDiagnosticCode::InvalidRelationship, "revises".into())));
    let cycle = edited(|v| v["sources"][1]["revises"] = json!("burnet-1902"));
    assert_eq!(
        problems(&cycle),
        [
            (SourceDiagnosticCode::RelationshipCycle, "revises".into()),
            (SourceDiagnosticCode::RelationshipCycle, "revises".into())
        ]
    );

    // A rendering is made from one text, never from the abstract work, and an
    // interpretation is never a library translation or a source.
    let from_work = edited(|v| v["interpretations"][0]["source"] = json!("plato-republic"));
    assert_eq!(
        problems(&from_work),
        [(
            SourceDiagnosticCode::InvalidRelationship,
            "interpretations[0].source".into()
        )]
    );
    let as_translation = edited(|v| v["interpretations"][0]["kind"] = json!("translation"));
    assert_eq!(
        problems(&as_translation),
        [(
            SourceDiagnosticCode::UnknownKind,
            "interpretations[0].kind".into()
        )]
    );
    let pointed_at = edited(|v| v["sources"][4]["of"] = json!("cave-514a-ada"));
    assert_eq!(
        problems(&pointed_at),
        [(SourceDiagnosticCode::UnresolvedRelationship, "of".into())]
    );
    assert!(
        library.get("cave-514a-ada").is_none(),
        "an interpretation is not a source"
    );
    let index = library.index();
    assert_eq!(index.dependents("burnet-1900"), ["burnet-1902"]);
}

#[test]
fn multi_volume_editions_need_a_volume_for_pages() {
    let library = versions();
    let location = library
        .get("burnet-iv-327")
        .unwrap()
        .location
        .as_ref()
        .unwrap();
    assert_eq!(location.volume.as_deref(), Some("4"));

    let missing = edited(|v| {
        v["sources"][6]["location"]
            .as_object_mut()
            .unwrap()
            .remove("volume");
    });
    assert_eq!(
        problems(&missing),
        [(
            SourceDiagnosticCode::AmbiguousLocation,
            "location.volume".into()
        )]
    );
    let beyond = edited(|v| v["sources"][6]["location"]["volume"] = json!("6"));
    assert_eq!(
        problems(&beyond),
        [(
            SourceDiagnosticCode::AmbiguousLocation,
            "location.volume".into()
        )]
    );
    // Canonical references do not depend on the volume.
    let canonical = edited(|v| {
        v["sources"][6]["location"] = json!({"scheme": "canonical", "value": "514a"});
    });
    assert!(parse(&canonical).is_ok());
    for bad in [json!(0), json!(1.5), json!("5"), json!(10_001)] {
        let text = edited(|v| v["sources"][1]["volumes"] = bad.clone());
        assert_eq!(
            problems(&text),
            [(SourceDiagnosticCode::InvalidField, "volumes".into())],
            "{bad}"
        );
    }
    let on_work = edited(|v| v["sources"][0]["volumes"] = json!(2));
    assert_eq!(
        problems(&on_work),
        [(SourceDiagnosticCode::InvalidField, "volumes".into())]
    );
}

#[test]
fn manuscript_witnesses_have_one_identity_per_held_copy() {
    let library = versions();
    let witness = library.get("paris-gr-1807").unwrap();
    assert_eq!(witness.shelfmark.as_deref(), Some("Grec 1807"));
    assert_eq!(
        witness.repository.as_deref(),
        Some("Bibliothèque nationale de France, Paris")
    );

    let duplicate = edited(|v| {
        let mut copy = v["sources"][5].clone();
        copy["id"] = json!("paris-gr-1807-again");
        v["sources"].as_array_mut().unwrap().push(copy);
    });
    let found = parse(&duplicate).unwrap_err();
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].code, SourceDiagnosticCode::DuplicateId);
    assert_eq!(found[0].field.as_deref(), Some("shelfmark"));
    assert_eq!(found[0].source_id.as_deref(), Some("paris-gr-1807-again"));

    // The same shelfmark in another repository is another copy.
    let elsewhere = edited(|v| {
        let mut copy = v["sources"][5].clone();
        copy["id"] = json!("vatican-copy");
        copy["repository"] = json!("Biblioteca Apostolica Vaticana");
        v["sources"].as_array_mut().unwrap().push(copy);
    });
    assert!(parse(&elsewhere).is_ok());

    let on_edition = edited(|v| v["sources"][1]["shelfmark"] = json!("X 1"));
    assert_eq!(
        problems(&on_edition),
        [(SourceDiagnosticCode::InvalidField, "shelfmark".into())]
    );
}

#[test]
fn anonymous_works_and_disputed_attribution_are_explicit() {
    let library = versions();
    let rhetoric = library.get("rhetorica-ad-alexandrum").unwrap();
    assert!(rhetoric.anonymous);
    assert_eq!(
        rhetoric
            .creators
            .iter()
            .map(|creator| creator.attribution)
            .collect::<Vec<_>>(),
        [
            Some(AttributionCertainty::Disputed),
            Some(AttributionCertainty::Attributed)
        ]
    );
    assert!(rhetoric.creators[0].note.is_some());

    let index = source_index("rhetorica-ad-alexandrum");
    for stated in [json!("stated"), Value::Null] {
        let text = edited(|v| {
            let creator = &mut v["sources"][index]["creators"][1];
            if stated.is_null() {
                creator.as_object_mut().unwrap().remove("attribution");
            } else {
                creator["attribution"] = stated.clone();
            }
        });
        assert_eq!(
            problems(&text),
            [(
                SourceDiagnosticCode::ConflictingAttribution,
                "creators[1].attribution".into()
            )],
            "an anonymous work cannot also state its author ({stated})"
        );
    }
    // A stated editor of an anonymous work's edition is no contradiction.
    let edition = edited(|v| {
        v["sources"].as_array_mut().unwrap().push(json!({
            "id": "rhetorica-fuhrmann", "kind": "edition", "of": "rhetorica-ad-alexandrum",
            "title": "Anaximenis Ars Rhetorica", "creators": [{"name": "M. Fuhrmann", "role": "editor"}]
        }));
    });
    assert!(parse(&edition).is_ok());

    let unknown = edited(|v| v["sources"][0]["creators"][0]["attribution"] = json!("probable"));
    assert_eq!(
        problems(&unknown),
        [(
            SourceDiagnosticCode::InvalidField,
            "creators[0].attribution".into()
        )]
    );
    let reference = edited(|v| v["sources"][6]["anonymous"] = json!(true));
    assert_eq!(
        problems(&reference),
        [(SourceDiagnosticCode::InvalidField, "anonymous".into())]
    );
}

#[test]
fn multiple_translators_and_interpreters_are_each_attributed() {
    let library = versions();
    let translators: Vec<&str> = library
        .get("republic-grube-reeve")
        .unwrap()
        .creators
        .iter()
        .filter(|creator| creator.role.as_deref() == Some("translator"))
        .map(|creator| creator.name.as_str())
        .collect();
    assert_eq!(translators, ["G. M. A. Grube", "C. D. C. Reeve"]);

    let rendering = library.interpretation("cave-514a-ada").unwrap();
    assert_eq!(rendering.kind, InterpretationKind::Rendering);
    assert_eq!(
        rendering.source, "burnet-1902",
        "provenance names the exact text"
    );
    assert_eq!(
        rendering
            .interpreters
            .iter()
            .map(|interpreter| interpreter.identity())
            .collect::<Vec<_>>(),
        [
            InterpreterIdentity::Contributor("ada"),
            InterpreterIdentity::Named("Grace Hopper")
        ]
    );
    assert_eq!(
        library
            .interpretations_of("paris-gr-1807")
            .map(|interpretation| interpretation.id.as_str())
            .collect::<Vec<_>>(),
        ["scholion-12r"]
    );
}

#[test]
fn attribution_reuses_contributor_identity_without_becoming_a_credit_or_citation() {
    // The registry decides who a contributor key is.
    let unknown =
        edited(|v| v["interpretations"][0]["interpreters"][0] = json!({"contributor": "grace"}));
    assert_eq!(
        problems(&unknown),
        [(
            SourceDiagnosticCode::UnresolvedRelationship,
            "interpretations[0].interpreters[0].contributor".into()
        )]
    );
    let both = edited(|v| {
        v["interpretations"][0]["interpreters"][0] =
            json!({"contributor": "ada", "name": "Ada L."});
    });
    assert_eq!(
        problems(&both),
        [(
            SourceDiagnosticCode::InvalidField,
            "interpretations[0].interpreters[0]".into()
        )]
    );
    // Contributors are interpreters, never the interpreted source.
    let cited = edited(|v| v["interpretations"][1]["source"] = json!("ada"));
    assert_eq!(
        problems(&cited),
        [(
            SourceDiagnosticCode::ContributorCredit,
            "interpretations[1].source".into()
        )]
    );
    // Credit sidecar fields stay out of interpretations at any depth.
    for (edit, field) in [
        (json!({"credits": []}), "interpretations[0].credits"),
        (
            json!({"rights": {"status": "ownWork", "contributors": ["ada"]}}),
            "interpretations[0].rights.contributors",
        ),
        (
            json!({"interpreters": [{"contributor": "ada", "credit": {"role": "author"}}]}),
            "interpretations[0].interpreters[0].credit",
        ),
    ] {
        let text = edited(|v| {
            for (key, value) in edit.as_object().unwrap() {
                v["interpretations"][0][key] = value.clone();
            }
        });
        assert_eq!(
            problems(&text),
            [(SourceDiagnosticCode::ContributorCredit, field.into())],
            "{edit}"
        );
    }
    // ...while a contributor key in a source record is still refused.
    let in_record = edited(|v| v["sources"][0]["creators"][0]["contributor"] = json!("ada"));
    assert_eq!(
        problems(&in_record),
        [(
            SourceDiagnosticCode::ContributorCredit,
            "creators[0].contributor".into()
        )]
    );
    // An interpretation id can never shadow a citation key.
    let shadow = edited(|v| v["interpretations"][1]["id"] = json!("burnet-1902"));
    assert_eq!(
        problems(&shadow),
        [(
            SourceDiagnosticCode::DuplicateId,
            "interpretations[1].id".into()
        )]
    );
    // Attribution is never left implicit.
    let unattributed = edited(|v| {
        v["interpretations"][1]
            .as_object_mut()
            .unwrap()
            .remove("interpreters");
    });
    assert_eq!(
        problems(&unattributed),
        [(
            SourceDiagnosticCode::MissingField,
            "interpretations[1].interpreters".into()
        )]
    );
    let anonymous_but_stated = edited(|v| {
        v["interpretations"][2]["interpreters"][0]["attribution"] = json!("stated");
    });
    assert_eq!(
        problems(&anonymous_but_stated),
        [(
            SourceDiagnosticCode::ConflictingAttribution,
            "interpretations[2].interpreters[0].attribution".into()
        )]
    );
}

#[test]
fn rights_are_the_authors_declaration_and_unknown_until_declared() {
    let library = versions();
    let status = |id: &str| library.get(id).unwrap().rights_status();
    assert_eq!(status("burnet-1900"), Some(RightsStatus::PublicDomain));
    assert_eq!(
        status("burnet-1902"),
        Some(RightsStatus::Unknown),
        "never inherited from the edition it revises"
    );
    assert_eq!(
        status("republic-grube-reeve"),
        Some(RightsStatus::RightsReserved)
    );
    assert_eq!(
        status("republic-grube-reeve-1992"),
        Some(RightsStatus::Unknown),
        "never inherited from the translation"
    );
    assert_eq!(
        status("plato-republic"),
        None,
        "a work has no text of its own"
    );
    assert_eq!(status("burnet-iv-327"), None);
    let witness = library
        .get("paris-gr-1807")
        .unwrap()
        .rights
        .clone()
        .unwrap();
    assert_eq!(witness.license.as_deref(), Some("Licence Ouverte 2.0"));
    assert_eq!(
        library
            .interpretation("cave-514a-ada")
            .unwrap()
            .rights_status(),
        RightsStatus::OwnWork
    );
    assert_eq!(
        library
            .interpretation("cave-reading-adam")
            .unwrap()
            .rights_status(),
        RightsStatus::Unknown
    );
    for status in RightsStatus::ALL {
        let label = status.label().to_lowercase();
        assert!(
            !label.contains("allowed") && !label.contains("may ") && !label.contains("cleared"),
            "{label}"
        );
    }

    for (rights, field) in [
        (json!({"note": "no status"}), "rights.status"),
        (json!({"status": "fairUse"}), "rights.status"),
        (
            json!({"status": "publicDomain", "license": "CC0"}),
            "rights.license",
        ),
        (
            json!({"status": "permission", "note": "line one\nline two"}),
            "rights.note",
        ),
        (json!("publicDomain"), "rights"),
    ] {
        let text = edited(|v| v["sources"][1]["rights"] = rights.clone());
        let found = problems(&text);
        assert_eq!(found.len(), 1, "{rights}: {found:?}");
        assert_eq!(found[0].1, field, "{rights}");
    }
    let on_work = edited(|v| v["sources"][0]["rights"] = json!({"status": "publicDomain"}));
    assert_eq!(
        problems(&on_work),
        [(SourceDiagnosticCode::InvalidField, "rights".into())]
    );
}

#[test]
fn interpretations_are_checked_like_untrusted_input() {
    let long = "x".repeat(20_001);
    for (edit, code, field) in [
        (
            json!({"text": long}),
            SourceDiagnosticCode::TooLarge,
            "interpretations[0].text",
        ),
        (
            json!({"text": "safe \u{202e}evil"}),
            SourceDiagnosticCode::InvalidField,
            "interpretations[0].text",
        ),
        (
            json!({"text": "  "}),
            SourceDiagnosticCode::MissingField,
            "interpretations[0].text",
        ),
        (
            json!({"language": "en_GB"}),
            SourceDiagnosticCode::InvalidField,
            "interpretations[0].language",
        ),
        (
            json!({"id": "../etc/passwd"}),
            SourceDiagnosticCode::InvalidId,
            "interpretations[0].id",
        ),
        (
            json!({"locators": [{"kind": "javascript", "value": "1"}]}),
            SourceDiagnosticCode::InvalidField,
            "interpretations[0].locators[0].kind",
        ),
        (
            json!({"locators": [{"kind": "timestamp", "value": "soon"}]}),
            SourceDiagnosticCode::InvalidField,
            "interpretations[0].locators[0].value",
        ),
        (
            json!({"locators": [{"kind": "folio", "value": "12r"}]}),
            SourceDiagnosticCode::AmbiguousLocation,
            "interpretations[0].locators[0].kind",
        ),
        (
            json!({"locators": []}),
            SourceDiagnosticCode::MissingField,
            "interpretations[0].locators",
        ),
        (
            json!({"source": "nowhere"}),
            SourceDiagnosticCode::UnresolvedRelationship,
            "interpretations[0].source",
        ),
        (
            json!({"source": "burnet-iv-327"}),
            SourceDiagnosticCode::InvalidRelationship,
            "interpretations[0].source",
        ),
    ] {
        let text = edited(|v| {
            for (key, value) in edit.as_object().unwrap() {
                v["interpretations"][0][key] = value.clone();
            }
        });
        assert_eq!(problems(&text), [(code, field.into())], "{edit}");
    }
    let too_many = edited(|v| {
        v["interpretations"][0]["locators"] = json!((0..9)
            .map(|n| json!({"kind": "line", "value": n.to_string()}))
            .collect::<Vec<_>>());
    });
    assert_eq!(
        problems(&too_many),
        [(
            SourceDiagnosticCode::TooLarge,
            "interpretations[0].locators".into()
        )]
    );
    let not_array = edited(|v| v["interpretations"] = json!({"id": "x"}));
    assert_eq!(
        problems(&not_array),
        [(SourceDiagnosticCode::InvalidField, "interpretations".into())]
    );

    // A single interpretation from a request reports paths relative to it.
    let diagnostics = Interpretation::from_json(json!({
        "id": "x", "kind": "rendering", "source": "burnet-1902", "text": "t",
        "interpreters": [{"name": "N"}]
    }))
    .unwrap_err();
    let fields: Vec<&str> = diagnostics
        .iter()
        .filter_map(|diagnostic| diagnostic.field.as_deref())
        .collect();
    assert_eq!(fields, ["language", "locators"]);
}

#[test]
fn failed_changes_leave_the_library_unchanged() {
    let contributors = contributors();
    let mut library = versions();
    let before = library.clone();

    let mut bad = library.interpretation("cave-514a-ada").unwrap().clone();
    bad.source = "plato-republic".into();
    let refused = library
        .upsert_interpretation(bad, &contributors)
        .unwrap_err();
    assert_eq!(
        refused[0].field.as_deref(),
        Some("interpretations[0].source")
    );
    assert_eq!(library, before);

    let mut shadowing = library.interpretation("cave-514a-ada").unwrap().clone();
    shadowing.extra.insert("text".into(), json!("shadow"));
    assert!(library
        .upsert_interpretation(shadowing, &contributors)
        .is_err());
    assert_eq!(library, before);

    let used = library.remove("paris-gr-1807", &contributors).unwrap_err();
    assert_eq!(used[0].code, SourceDiagnosticCode::StillUsed);
    assert!(
        used[0].message.contains("scholion-12r"),
        "{}",
        used[0].message
    );
    assert_eq!(library, before);

    let unknown = library
        .remove_interpretation("missing", &contributors)
        .unwrap_err();
    assert_eq!(unknown[0].code, SourceDiagnosticCode::UnknownSource);
    assert_eq!(library, before);

    // Valid changes apply as a whole.
    let mut renamed = library.interpretation("cave-reading-adam").unwrap().clone();
    renamed.uncertainty = None;
    library
        .upsert_interpretation(renamed, &contributors)
        .unwrap();
    assert!(library
        .interpretation("cave-reading-adam")
        .unwrap()
        .uncertainty
        .is_none());
    let removed = library
        .remove_interpretation("scholion-12r", &contributors)
        .unwrap();
    assert_eq!(removed.id, "scholion-12r");
    library.remove("paris-12r", &contributors).unwrap();
    library.remove("paris-gr-1807", &contributors).unwrap();

    // Without the registry, a contributor-attributed interpretation cannot
    // be read, so a broken registry is never silently accepted.
    assert!(SourceLibrary::parse(VERSIONS, &BTreeMap::new()).is_err());
}

#[test]
fn private_declarations_never_reach_the_public_reference_description() {
    let library = versions();
    for id in [
        "burnet-1900",
        "republic-grube-reeve",
        "paris-gr-1807",
        "rhetorica-ad-alexandrum",
    ] {
        let public = serde_json::to_string(&public_reference(library.get(id).unwrap())).unwrap();
        for private in [
            "rights",
            "publicDomain",
            "rightsReserved",
            "Hackett, 1992",
            "Licence Ouverte",
            "Grec 1807",
            "Bibliothèque nationale",
            "disputed",
            "attributed",
            "many scholars",
            "Revised the 1974",
            "anonymous",
            "volumes",
            "revises",
        ] {
            assert!(!public.contains(private), "{id} leaks {private}: {public}");
        }
    }
}

#[test]
fn interchange_carries_version_provenance_and_keeps_interpretations() {
    let library = versions();
    let export = export_csl_json(&library);
    assert!(export.losses.is_empty());
    let plan = plan_csl_import(&library, &export.content, &contributors()).unwrap();
    assert!(
        plan.entries
            .iter()
            .all(|entry| entry.action == ImportAction::Unchanged),
        "{:?}",
        plan.entries
    );
    let applied = plan.apply(&library, &contributors()).unwrap();
    assert_eq!(
        applied, library,
        "importing the export changes nothing, interpretations included"
    );

    // Into an empty library, every provenance field arrives intact.
    let fresh = plan_csl_import(&SourceLibrary::default(), &export.content, &BTreeMap::new())
        .unwrap()
        .apply(&SourceLibrary::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(fresh.sources, library.sources);
    assert!(
        fresh.interpretations.is_empty(),
        "interpretations are not bibliography"
    );

    let bibtex = export_bibtex(&library);
    let lost: Vec<(&str, &str)> = bibtex
        .losses
        .iter()
        .map(|loss| (loss.source_id.as_str(), loss.field.as_str()))
        .collect();
    for expected in [
        ("burnet-1900", "rights"),
        ("burnet-1900", "volumes"),
        ("burnet-1902", "revises"),
        ("paris-gr-1807", "shelfmark"),
        ("paris-gr-1807", "anonymous"),
        ("rhetorica-ad-alexandrum", "creators"),
    ] {
        assert!(lost.contains(&expected), "{expected:?} in {lost:?}");
    }
    assert!(
        !bibtex.content.contains("Hackett"),
        "BibTeX never carries a rights note"
    );
}

#[test]
fn a_record_built_in_code_starts_with_no_provenance() {
    let record = SourceRecord::new("w", ResearchSourceKind::Witness);
    assert!(record.is_version());
    assert_eq!(record.rights_status(), Some(RightsStatus::Unknown));
    assert!(!record.anonymous && record.revises.is_none() && record.volumes.is_none());
}

#[test]
fn the_documented_interpretation_example_is_valid() {
    let spec = include_str!("../../../docs/specs/research-source-library.md");
    let blocks: Vec<&str> = spec
        .split("```json")
        .skip(1)
        .filter_map(|rest| rest.split("```").next())
        .collect();
    let mut library: Value = serde_json::from_str(blocks[0]).unwrap();
    let fragment: Value = serde_json::from_str(&format!("{{{}}}", blocks[1])).unwrap();
    library["interpretations"] = fragment["interpretations"].clone();
    let parsed = parse(&library.to_string()).unwrap();
    assert_eq!(parsed.interpretations.len(), 1);
    assert_eq!(
        parsed.interpretations[0].kind,
        InterpretationKind::Rendering
    );
}

#[test]
fn an_import_fills_in_attribution_and_reports_a_differing_one_as_a_conflict() {
    let export = export_csl_json(&versions()).content;
    let index = source_index("rhetorica-ad-alexandrum");
    let held = |edit: &dyn Fn(&mut Value)| {
        parse(&edited(|value| {
            edit(&mut value["sources"][index]["creators"][0])
        }))
        .unwrap()
    };
    let entry = |library: &SourceLibrary| {
        plan_csl_import(library, &export, &contributors())
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source_id.as_deref() == Some("rhetorica-ad-alexandrum"))
            .unwrap()
    };

    // The library has no attribution or note for Aristotle: the item's fill in.
    let bare = held(&|creator| {
        let creator = creator.as_object_mut().unwrap();
        creator.remove("attribution");
        creator.remove("note");
        creator.remove("role");
    });
    let filled = entry(&bare);
    assert_eq!(filled.action, ImportAction::Update, "{filled:?}");
    let plan = plan_csl_import(&bare, &export, &contributors()).unwrap();
    let applied = plan.apply(&bare, &contributors()).unwrap();
    let creator = &applied.get("rhetorica-ad-alexandrum").unwrap().creators[0];
    assert_eq!(creator.attribution, Some(AttributionCertainty::Disputed));
    assert!(creator.note.as_deref().unwrap().contains("Anaximenes"));

    // Two different statements are never settled silently.
    let doubted = held(&|creator| creator["attribution"] = json!("uncertain"));
    let conflict = entry(&doubted);
    assert_eq!(conflict.action, ImportAction::Conflict);
    assert_eq!(
        conflict
            .diagnostics
            .iter()
            .map(|d| (d.code, d.field.clone().unwrap_or_default()))
            .collect::<Vec<_>>(),
        [(
            SourceDiagnosticCode::ConflictingAttribution,
            "creators[0].attribution".to_string()
        )]
    );
    let renoted = held(&|creator| creator["note"] = json!("Another note"));
    let conflict = entry(&renoted);
    assert_eq!(conflict.action, ImportAction::Conflict);
    assert_eq!(
        conflict.diagnostics[0].field.as_deref(),
        Some("creators[0].note")
    );
    assert!(!conflict.diagnostics[0].message.contains("Another note"));
}

#[test]
fn an_import_cannot_take_an_interpretations_id() {
    let library = versions();
    let plan = plan_csl_import(
        &library,
        r#"[{"id": "cave-514a-ada", "type": "book", "title": "A book"}]"#,
        &contributors(),
    )
    .unwrap();
    let entry = &plan.entries[0];
    assert_eq!(entry.action, ImportAction::Conflict);
    assert_eq!(
        entry
            .diagnostics
            .iter()
            .map(|d| (d.code, d.source_id.as_deref(), d.field.as_deref()))
            .collect::<Vec<_>>(),
        [(
            SourceDiagnosticCode::DuplicateId,
            Some("cave-514a-ada"),
            Some("id")
        )],
        "the conflict is scoped to the item, not to the interpretation"
    );
    assert!(plan.diagnostics.is_empty());
}

#[test]
fn a_build_validates_only_the_interpretations_it_names() {
    // The second interpretation is broken; nothing published names it.
    let text =
        edited(|v| v["interpretations"][1]["interpreters"][0] = json!({"contributor": "grace"}));
    let mut library = SourceLibrary::parse_for_build(&text, &contributors())
        .expect("a build never validates interpretations wholesale");
    assert!(library.interpretations.is_empty());
    assert!(
        library.has_interpretation("cave-reading-adam"),
        "raw entries still exist"
    );
    assert!(!library.has_interpretation("nowhere"));

    let named = std::collections::BTreeSet::from(["cave-514a-ada".to_string()]);
    library
        .validate_interpretations_for_build(&named, &contributors())
        .expect("the named interpretation is valid");
    assert_eq!(
        library
            .interpretation("cave-514a-ada")
            .map(|interpretation| interpretation.text.lines().count()),
        Some(2)
    );
    assert!(library.interpretation("cave-reading-adam").is_none());

    // Naming the broken one refuses, naming its id and stored position.
    let mut library = SourceLibrary::parse_for_build(&text, &contributors()).unwrap();
    let named = std::collections::BTreeSet::from(["cave-reading-adam".to_string()]);
    let failures = library
        .validate_interpretations_for_build(&named, &contributors())
        .expect_err("a named interpretation must be valid");
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].0, "cave-reading-adam");
    assert_eq!(
        failures[0]
            .1
            .iter()
            .map(|d| (d.code, d.field.clone().unwrap_or_default()))
            .collect::<Vec<_>>(),
        [(
            SourceDiagnosticCode::UnresolvedRelationship,
            "interpretations[1].interpreters[0].contributor".to_string()
        )]
    );
    assert!(
        library.interpretations.is_empty(),
        "nothing is added on failure"
    );
}
