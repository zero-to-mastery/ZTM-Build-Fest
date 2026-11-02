//! Uncertain chronology in the Knowledge Atlas (ADR 0093 to 0095): precision
//! and uncertainty survive round trips, competing datings coexist with their
//! attribution, unknown is never coerced to a date, BCE has no year 0,
//! calendars are never converted, relative datings are asserted and cited,
//! version 1 `bounds` are upgraded without loss, and failures are scoped.

use std::collections::BTreeMap;

use openblog_core::chronology::{
    by_aspect, chronological, Aspect, Calendar, ChronoKey, DateForm, Dating, Point, Precision,
    Stated, TemporalOrder,
};
use openblog_core::knowledge_atlas::{
    Atlas, AtlasDiagnostic, AtlasDiagnosticCode as Code, Entry, Links, Visibility, ATLAS_VERSION,
};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use serde_json::{json, Value};

fn library() -> SourceLibrary {
    let text = json!({"version": 1, "sources": [
        {"id": "plato-republic", "kind": "work", "title": "Politeia"},
        {"id": "republic-slings", "kind": "edition", "of": "plato-republic", "title": "Platonis Rempublicam"},
        {"id": "diogenes", "kind": "work", "title": "Lives of the Eminent Philosophers"},
        {"id": "nails-2002", "kind": "work", "title": "The People of Plato"}
    ]})
    .to_string();
    SourceLibrary::parse(&text, &BTreeMap::new()).expect("library")
}

fn notebook(library: &SourceLibrary) -> Notebook {
    let text = json!({"version": 1,
        "passages": [{"id": "p-born", "source": "diogenes", "excerpt": {"text": "born in"}}]})
    .to_string();
    Notebook::parse(&text, library).expect("notebook")
}

fn parse(value: &Value) -> Result<Atlas, Vec<AtlasDiagnostic>> {
    let library = library();
    let notebook = notebook(&library);
    Atlas::parse(
        &value.to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
}

fn codes(value: &Value) -> Vec<Code> {
    match parse(value) {
        Ok(_) => panic!("expected the atlas to be refused"),
        Err(found) => found.iter().map(|d| d.code).collect(),
    }
}

fn cited(id: &str, aspect: &str, date: Value) -> Value {
    json!({"id": id, "aspect": aspect, "date": date,
        "assertedBy": {"kind": "source", "source": "diogenes"},
        "evidence": [{"source": "diogenes", "locators": [{"kind": "canonical", "value": "3.2"}]}]})
}

fn atlas_with(plato_dates: Value) -> Value {
    json!({"version": 2,
        "entries": [
            {"id": "plato", "kind": "person", "label": "Plato", "dates": plato_dates},
            {"id": "republic", "kind": "work", "label": "Republic", "source": "plato-republic"},
            {"id": "phaedo", "kind": "work", "label": "Phaedo"},
            {"id": "academy", "kind": "movement", "label": "The Academy"},
            {"id": "forms", "kind": "concept", "label": "Theory of Forms"}],
        "relationships": [
            {"id": "r-authored", "kind": "authored", "from": "plato", "to": "republic",
             "assertedBy": {"kind": "author"}, "evidence": [{"source": "republic-slings"}]}]})
}

fn with_date(date: Value) -> Value {
    atlas_with(json!([cited("d", "span", date)]))
}

fn only_dating(atlas: &Atlas) -> &Dating {
    &atlas.entry("plato").unwrap().dates[0]
}

#[test]
fn precision_and_uncertainty_survive_round_trips_exactly() {
    let dates = json!([
        cited(
            "d-year",
            "birth",
            json!({"at": {"year": -428, "circa": true}})
        ),
        cited(
            "d-day",
            "death",
            json!({"at": {"year": -348, "month": 6, "day": 1, "calendar": "julian"}})
        ),
        cited("d-month", "span", json!({"at": {"year": 1789, "month": 7}})),
        cited(
            "d-decade",
            "active",
            json!({"from": {"decade": -390}, "to": {"decade": -350, "circa": true}})
        ),
        cited("d-century", "active", json!({"at": {"century": -4}})),
        cited(
            "d-window",
            "birth",
            json!({"notBefore": {"year": -429}, "notAfter": {"year": -423}})
        ),
        cited("d-after", "death", json!({"notBefore": {"year": -350}})),
        cited("d-before", "death", json!({"notAfter": {"year": -340}})),
        cited("d-from", "span", json!({"from": {"year": -428}})),
        cited("d-unknown", "birth", json!({"unknown": true})),
        cited(
            "d-relative",
            "death",
            json!({"relative": {"order": "after", "entry": "republic", "aspect": "composition"}})
        ),
    ]);
    let value = atlas_with(dates.clone());
    let atlas = parse(&value).expect("valid");
    let written: Value = serde_json::from_str(&atlas.to_json()).unwrap();
    assert_eq!(written["version"], json!(ATLAS_VERSION));
    let mut expected = dates.as_array().unwrap().clone();
    for dating in &mut expected {
        dating["confidence"] = json!("tentative");
        dating["visibility"] = json!("private");
    }
    assert_eq!(written["entries"][0]["dates"], Value::Array(expected));
    let again = parse(&written).expect("re-read");
    assert_eq!(again, atlas);
    assert_eq!(
        again.to_json(),
        atlas.to_json(),
        "the written form is stable"
    );

    let plato = atlas.entry("plato").unwrap();
    let precision = |i: usize| match &plato.dates[i].date.form {
        DateForm::At(point) => point.precision(),
        DateForm::Span { from: Some(p), .. } => p.precision(),
        other => panic!("unexpected form {other:?}"),
    };
    assert_eq!(
        [
            precision(0),
            precision(1),
            precision(2),
            precision(3),
            precision(4)
        ],
        [
            Precision::Year,
            Precision::Day,
            Precision::Month,
            Precision::Decade,
            Precision::Century
        ]
    );
    match &plato.dates[0].date.form {
        DateForm::At(point) => assert!(point.circa, "circa is kept, never dropped"),
        other => panic!("{other:?}"),
    }
    match &plato.dates[1].date.form {
        DateForm::At(point) => assert_eq!(point.calendar, Some(Calendar::Julian)),
        other => panic!("{other:?}"),
    }
}

#[test]
fn competing_datings_coexist_with_their_attribution_and_none_is_chosen() {
    let mut nails = cited(
        "birth-nails",
        "birth",
        json!({"notBefore": {"year": -424}, "notAfter": {"year": -423}}),
    );
    nails["assertedBy"] = json!({"kind": "source", "source": "nails-2002"});
    nails["evidence"] = json!([{"source": "nails-2002"}]);
    let mut author = json!({"id": "birth-author", "aspect": "birth",
        "date": {"unknown": true}, "assertedBy": {"kind": "author"}, "unsourced": true,
        "note": "The ancient reckonings disagree."});
    author["confidence"] = json!("plausible");
    let value = atlas_with(json!([
        cited(
            "birth-diogenes",
            "birth",
            json!({"at": {"year": -428, "circa": true}})
        ),
        nails,
        author,
        cited("death-diogenes", "death", json!({"at": {"year": -348}})),
    ]));
    let atlas = parse(&value).expect("competing datings are valid side by side");
    let plato = atlas.entry("plato").unwrap();
    let groups = by_aspect(&plato.dates);
    let births: Vec<&str> = groups[&Aspect::Birth]
        .iter()
        .map(|d| d.id.as_str())
        .collect();
    assert_eq!(
        births,
        ["birth-diogenes", "birth-nails", "birth-author"],
        "every party's dating is kept, in file order"
    );
    let parties: Vec<_> = groups[&Aspect::Birth]
        .iter()
        .map(|d| (d.asserted_by.source.clone(), d.asserted_by.name.clone()))
        .collect();
    assert_eq!(parties[0].0.as_deref(), Some("diogenes"));
    assert_eq!(parties[1].0.as_deref(), Some("nails-2002"));
    assert_eq!(parties[2], (None, None), "the author's own reading");
    let text = atlas.to_json().to_lowercase();
    for word in ["preferred", "consensus", "resolved", "agreed"] {
        assert!(!text.contains(word), "{word}");
    }

    // The same party may give alternatives, but not the same date twice.
    let mut repeated = value.clone();
    let mut twin = repeated["entries"][0]["dates"][0].clone();
    twin["id"] = json!("birth-diogenes-again");
    twin["date"]["at"]["note-ignored"] = json!(1);
    repeated["entries"][0]["dates"]
        .as_array_mut()
        .unwrap()
        .push(twin.clone());
    assert_eq!(codes(&repeated), [Code::DuplicateDating]);
    twin["date"] = json!({"at": {"year": -427}});
    let mut alternative = value;
    alternative["entries"][0]["dates"]
        .as_array_mut()
        .unwrap()
        .push(twin);
    assert!(parse(&alternative).is_ok(), "an alternative from one party");
}

#[test]
fn unknown_is_never_coerced_to_a_date() {
    let atlas = parse(&with_date(json!({"unknown": true}))).expect("valid");
    let dating = only_dating(&atlas);
    assert_eq!(dating.date.form, DateForm::Unknown);
    assert_eq!(dating.key(), ChronoKey::Unknown);
    assert!(atlas.to_json().contains("\"unknown\": true"));

    for (date, code) in [
        (json!({"unknown": false}), Code::InvalidField),
        (json!({"unknown": "yes"}), Code::InvalidField),
        (json!({}), Code::MissingField),
        (json!({"at": {}}), Code::MissingField),
        (json!({"at": {"circa": true}}), Code::MissingField),
        (json!({"at": {"month": 3}}), Code::MissingField),
        (json!({"from": {}, "to": {}}), Code::MissingField),
        (
            json!({"unknown": true, "at": {"year": 1}}),
            Code::InvalidDate,
        ),
        (
            json!({"at": {"year": 1}, "notBefore": {"year": 1}}),
            Code::InvalidDate,
        ),
    ] {
        let found = codes(&with_date(date.clone()));
        assert!(found.contains(&code), "{date}: {found:?}");
    }
    // An entry or relationship without datings is simply undated.
    let undated = parse(&atlas_with(json!([]))).unwrap();
    assert!(undated.entry("plato").unwrap().dates.is_empty());
    assert!(!undated.to_json().contains("\"dates\""));
}

#[test]
fn bce_and_ce_meet_without_a_year_zero() {
    for point in [
        json!({"year": 0}),
        json!({"decade": 0}),
        json!({"century": 0}),
        json!({"decade": 15}),
        json!({"year": 100_001}),
        json!({"year": -100_001}),
        json!({"century": 1001}),
        json!({"year": 1.5}),
        json!({"year": "428 BCE"}),
        json!({"year": -428, "century": -5}),
    ] {
        let found = codes(&with_date(json!({ "at": point.clone() })));
        assert!(
            found
                .iter()
                .all(|c| matches!(c, Code::InvalidDate | Code::InvalidField)),
            "{point}: {found:?}"
        );
    }
    let years = |point: Value| {
        let atlas = parse(&with_date(json!({ "at": point }))).unwrap();
        match &only_dating(&atlas).date.form {
            DateForm::At(p) => p.years(),
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(years(json!({"year": -1})), (-1, -1));
    assert_eq!(years(json!({"decade": -10})), (-19, -10), "the 10s BCE");
    assert_eq!(years(json!({"decade": 10})), (10, 19), "the 10s CE");
    assert_eq!(years(json!({"decade": -380})), (-389, -380), "the 380s BCE");
    assert_eq!(years(json!({"century": -1})), (-100, -1), "1st century BCE");
    assert_eq!(years(json!({"century": 1})), (1, 100), "1st century CE");
    assert_eq!(years(json!({"century": -4})), (-400, -301));
    assert_eq!(years(json!({"century": 21})), (2001, 2100));

    // 1 BCE is directly followed by 1 CE.
    assert!(parse(&with_date(json!({"from": {"year": -1}, "to": {"year": 1}}))).is_ok());
    assert_eq!(
        codes(&with_date(json!({"from": {"year": 1}, "to": {"year": -1}}))),
        [Code::InvalidDate]
    );
    assert_eq!(
        codes(&with_date(
            json!({"notBefore": {"century": -3}, "notAfter": {"decade": -390}})
        )),
        [Code::InvalidDate],
        "the 3rd century BCE begins after the 390s BCE end"
    );
    assert!(parse(&with_date(
        json!({"notBefore": {"century": -4}, "notAfter": {"decade": -390}})
    ))
    .is_ok());
}

#[test]
fn calendars_are_named_never_converted() {
    let day = |point: Value| codes(&with_date(json!({ "at": point })));
    assert_eq!(
        day(json!({"year": 1700, "calendar": "julian"})),
        [Code::InvalidDate],
        "a calendar applies to a month and day, not a year"
    );
    assert_eq!(
        day(json!({"year": 1700, "month": 3, "calendar": "attic"})),
        [Code::InvalidField]
    );
    assert_eq!(day(json!({"year": 1700, "month": 13})), [Code::InvalidDate]);
    assert_eq!(
        day(json!({"year": 1700, "month": 2, "day": 30})),
        [Code::InvalidDate]
    );
    assert_eq!(day(json!({"year": 1700, "day": 3})), [Code::InvalidDate]);
    assert_eq!(
        day(json!({"decade": 1700, "month": 3})),
        [Code::InvalidDate]
    );
    assert!(
        parse(&with_date(
            json!({"at": {"year": 1700, "month": 2, "day": 29, "calendar": "julian"}})
        ))
        .is_ok(),
        "February 29 exists in some calendar years, and nothing converts them"
    );

    // Within one calendar months and days are ordered; across calendars only years are.
    let range = |from: Value, to: Value| with_date(json!({"from": from, "to": to}));
    assert_eq!(
        codes(&range(
            json!({"year": 1700, "month": 3, "day": 1, "calendar": "julian"}),
            json!({"year": 1700, "month": 2, "day": 20, "calendar": "julian"})
        )),
        [Code::InvalidDate]
    );
    assert!(parse(&range(
        json!({"year": 1700, "month": 3, "day": 1, "calendar": "julian"}),
        json!({"year": 1700, "month": 2, "day": 20, "calendar": "gregorian"})
    ))
    .is_ok());
    assert_eq!(
        codes(&range(
            json!({"year": 1701, "month": 1, "calendar": "julian"}),
            json!({"year": 1700, "month": 12, "calendar": "gregorian"})
        )),
        [Code::InvalidDate]
    );
    let atlas = parse(&with_date(
        json!({"at": {"year": 1700, "month": 2, "day": 29, "calendar": "gregorian"}}),
    ))
    .unwrap();
    assert!(atlas.to_json().contains("\"calendar\": \"gregorian\""));
}

#[test]
fn sorting_is_deterministic_over_partial_open_and_unknown_dates() {
    let dates = json!([
        cited("unknown", "span", json!({"unknown": true})),
        cited(
            "relative",
            "death",
            json!({"relative": {"order": "after", "entry": "republic", "aspect": "composition"}})
        ),
        cited("ce-1", "span", json!({"at": {"year": 1}})),
        cited("bce-1", "span", json!({"at": {"year": -1}})),
        cited("century-bce-4", "span", json!({"at": {"century": -4}})),
        cited("before-400", "span", json!({"notAfter": {"year": -400}})),
        cited("decade-380s", "span", json!({"at": {"decade": -380}})),
        cited(
            "circa-389",
            "span",
            json!({"at": {"year": -389, "circa": true}})
        ),
        cited("year-389", "birth", json!({"at": {"year": -389}})),
        cited("after-300", "span", json!({"notBefore": {"year": -300}})),
        cited(
            "month-389",
            "death",
            json!({"at": {"year": -389, "month": 5}})
        ),
    ]);
    let expected = [
        "before-400",
        "century-bce-4",
        "circa-389",
        "year-389",
        "decade-380s",
        "month-389",
        "after-300",
        "bce-1",
        "ce-1",
        "relative",
        "unknown",
    ];
    let mut items = dates.as_array().unwrap().clone();
    for turn in 0..items.len() {
        items.rotate_left(turn.min(1));
        let atlas = parse(&atlas_with(Value::Array(items.clone()))).expect("valid");
        let mut sorted: Vec<&Dating> = atlas.entry("plato").unwrap().dates.iter().collect();
        sorted.sort_by(|a, b| chronological(a, b));
        let ids: Vec<&str> = sorted.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, expected, "rotation {turn}");
    }
    let atlas = parse(&atlas_with(dates)).unwrap();
    let plato = atlas.entry("plato").unwrap();
    assert_eq!(
        plato.dates[5].key(),
        ChronoKey::Dated {
            start: (i32::MIN, 0, 0),
            end: (-400, 12, 31)
        },
        "an open start sorts before every year"
    );
    assert!(matches!(plato.dates[1].key(), ChronoKey::Relative));
}

#[test]
fn every_dating_is_attributed_and_cited_or_an_explicit_draft() {
    let draft = |extra: Value| {
        let mut dating = json!({"id": "d", "aspect": "birth", "date": {"at": {"year": -428}},
            "assertedBy": {"kind": "author"}});
        for (key, value) in extra.as_object().unwrap() {
            dating[key] = value.clone();
        }
        atlas_with(json!([dating]))
    };
    assert_eq!(codes(&draft(json!({}))), [Code::MissingEvidence]);
    assert!(parse(&draft(json!({"unsourced": true}))).is_ok());
    assert_eq!(
        codes(&draft(
            json!({"unsourced": true, "evidence": [{"source": "diogenes"}]})
        )),
        [Code::EvidenceConflict]
    );
    assert_eq!(
        codes(&draft(json!({"unsourced": true, "confidence": "strong"}))),
        [Code::EvidenceConflict]
    );
    assert_eq!(
        codes(&draft(json!({"unsourced": true, "visibility": "approved"}))),
        [Code::MissingEvidence]
    );
    assert_eq!(
        codes(&draft(
            json!({"evidence": [{"source": "diogenes", "passage": "p-born"}], "visibility": "approved"})
        )),
        [Code::PrivateReference]
    );
    assert!(parse(&draft(
        json!({"evidence": [{"source": "diogenes", "passage": "p-born"}]})
    ))
    .is_ok());
    assert_eq!(
        codes(&draft(json!({"evidence": [{"source": "ghost"}]}))),
        [Code::UnknownSource]
    );
    assert_eq!(
        codes(&draft(
            json!({"evidence": [{"source": "diogenes", "passage": "ghost"}]})
        )),
        [Code::UnknownPassage]
    );
    assert_eq!(
        codes(&draft(
            json!({"assertedBy": {"kind": "source", "source": "ghost"}, "unsourced": true})
        )),
        [Code::UnknownSource]
    );
    assert_eq!(
        codes(&draft(
            json!({"assertedBy": {"kind": "named"}, "unsourced": true})
        )),
        [Code::MissingField]
    );
    assert_eq!(
        codes(&draft(json!({"unsourced": true, "credits": []}))),
        [Code::ContributorCredit]
    );
    assert_eq!(
        codes(&draft(json!({"unsourced": true, "visibility": "public"}))),
        [Code::InvalidVisibility]
    );

    // Datings that use a source or passage protect it like any other use.
    let mut value = draft(json!({"evidence": [{"source": "diogenes", "passage": "p-born"}]}));
    value["relationships"][0]["dates"] = json!([{"id": "held", "aspect": "span",
        "date": {"from": {"year": -387}}, "assertedBy": {"kind": "source", "source": "nails-2002"},
        "evidence": [{"source": "nails-2002"}]}]);
    let atlas = parse(&value).unwrap();
    assert_eq!(atlas.uses_of_source("diogenes"), ["plato"]);
    assert_eq!(atlas.uses_of_source("nails-2002"), ["r-authored"]);
    assert_eq!(atlas.uses_of_passage("p-born"), ["plato"]);
    let index = atlas.index();
    assert_eq!(index.by_source["diogenes"], ["plato"]);
    assert_eq!(index.by_passage["p-born"], ["plato"]);
}

#[test]
fn aspects_belong_to_what_they_date() {
    let entry_dating = |entry: usize, aspect: &str, date: Value| {
        let mut value = atlas_with(json!([]));
        value["entries"][entry]["dates"] = json!([cited("d", aspect, date)]);
        value
    };
    let year = json!({"at": {"year": -380}});
    assert!(parse(&entry_dating(1, "composition", year.clone())).is_ok());
    assert!(parse(&entry_dating(1, "publication", year.clone())).is_ok());
    assert!(parse(&entry_dating(3, "active", year.clone())).is_ok());
    assert!(parse(&entry_dating(4, "emergence", year.clone())).is_ok());
    assert_eq!(
        codes(&entry_dating(1, "birth", year.clone())),
        [Code::AspectKind]
    );
    assert_eq!(
        codes(&entry_dating(4, "death", year.clone())),
        [Code::AspectKind]
    );
    assert_eq!(
        codes(&entry_dating(0, "floruit", year.clone())),
        [Code::UnknownKind]
    );
    assert_eq!(
        codes(&entry_dating(
            0,
            "birth",
            json!({"from": {"year": -428}, "to": {"year": -427}})
        )),
        [Code::AspectKind],
        "a birth is a window, not a duration"
    );
    assert!(parse(&entry_dating(
        0,
        "span",
        json!({"from": {"year": -428}, "to": {"year": -348}})
    ))
    .is_ok());
    assert_eq!(
        Aspect::of_entry(openblog_core::knowledge_atlas::EntryKind::Person),
        [Aspect::Span, Aspect::Birth, Aspect::Death, Aspect::Active]
    );

    let mut value = atlas_with(json!([]));
    value["relationships"][0]["dates"] =
        json!([cited("held", "span", json!({"notAfter": {"year": -347}}))]);
    let atlas = parse(&value).expect("a relationship is dated by when it held");
    assert_eq!(atlas.relationships[0].dates[0].id, "held");
    value["relationships"][0]["dates"][0]["aspect"] = json!("birth");
    assert_eq!(codes(&value), [Code::AspectKind]);
}

#[test]
fn relative_datings_are_asserted_cited_and_never_become_relationships() {
    let relative = |entry: &str, aspect: &str, order: &str| {
        let mut value = atlas_with(json!([]));
        value["entries"][1]["dates"] = json!([cited(
            "republic-after",
            "composition",
            json!({"relative": {"order": order, "entry": entry, "aspect": aspect}})
        )]);
        value
    };
    let atlas = parse(&relative("phaedo", "composition", "after")).expect("valid");
    let dating = &atlas.entry("republic").unwrap().dates[0];
    let target = dating.relative_target().unwrap();
    assert_eq!(
        (target.order, target.entry.as_str(), target.aspect),
        (TemporalOrder::After, "phaedo", Aspect::Composition)
    );
    assert_eq!(dating.asserted_by.source.as_deref(), Some("diogenes"));
    assert_eq!(atlas.relationships.len(), 1, "no relationship is created");
    assert!(atlas.relationships_of("phaedo").is_empty());
    assert_eq!(
        atlas
            .datings_of("phaedo")
            .iter()
            .map(|(owner, d)| (*owner, d.id.as_str()))
            .collect::<Vec<_>>(),
        [("republic", "republic-after")]
    );

    assert_eq!(
        codes(&relative("ghost", "composition", "after")),
        [Code::UnknownEntry]
    );
    assert_eq!(
        codes(&relative("r-authored", "span", "after")),
        [Code::UnknownEntry]
    );
    assert_eq!(
        codes(&relative("phaedo", "birth", "after")),
        [Code::AspectKind]
    );
    assert_eq!(
        codes(&relative("phaedo", "publication", "during")),
        [Code::AspectKind]
    );
    assert_eq!(
        codes(&relative("phaedo", "composition", "around")),
        [Code::UnknownKind]
    );
    assert_eq!(
        codes(&relative("republic", "composition", "after")),
        [Code::InvalidDate]
    );
    assert!(
        parse(&relative("republic", "publication", "before")).is_ok(),
        "another aspect of the same entry"
    );
    assert!(parse(&relative("plato", "span", "during")).is_ok());

    // Opposed relative datings by different parties are recorded, not refused:
    // judging them is the chronology index's structural warning, never a rule.
    let mut opposed = relative("phaedo", "composition", "after");
    let mut other = cited(
        "phaedo-after",
        "composition",
        json!({"relative": {"order": "after", "entry": "republic", "aspect": "composition"}}),
    );
    other["assertedBy"] = json!({"kind": "source", "source": "nails-2002"});
    other["evidence"] = json!([{"source": "nails-2002"}]);
    opposed["entries"][2]["dates"] = json!([other]);
    assert!(parse(&opposed).is_ok());
}

#[test]
fn dating_ids_share_the_atlas_identifier_space() {
    let mut value = atlas_with(json!([cited(
        "phaedo",
        "birth",
        json!({"at": {"year": -428}})
    )]));
    assert_eq!(codes(&value), [Code::DuplicateId]);
    value["entries"][0]["dates"] = json!([cited("d", "birth", json!({"at": {"year": -428}}))]);
    value["relationships"][0]["dates"] = json!([cited("d", "span", json!({"at": {"year": -380}}))]);
    let found = parse(&value).unwrap_err();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].code, Code::DuplicateId);
    assert_eq!(found[0].collection, Some("relationships"));
    assert_eq!(found[0].field.as_deref(), Some("dates[0].id"));
    value["relationships"][0]["dates"][0]["id"] = json!("Not A Slug");
    assert_eq!(codes(&value), [Code::InvalidId]);
}

#[test]
fn failures_are_scoped_and_leave_the_atlas_unchanged() {
    let value = atlas_with(json!([
        cited("ok", "birth", json!({"at": {"year": -428}})),
        cited("bad", "death", json!({"at": {"year": -348, "month": 14}})),
    ]));
    let found = parse(&value).unwrap_err();
    assert_eq!(found.len(), 1);
    let d = &found[0];
    assert_eq!(
        (
            d.code,
            d.collection,
            d.index,
            d.id.as_deref(),
            d.field.as_deref()
        ),
        (
            Code::InvalidDate,
            Some("entries"),
            Some(0),
            Some("plato"),
            Some("dates[1].date.at.month")
        )
    );

    let mut hostile = atlas_with(json!([]));
    let mut note = cited("n", "birth", json!({"at": {"year": -428}}));
    note["note"] = json!("a\u{202e}b");
    hostile["entries"][0]["dates"] = json!([note]);
    let found = parse(&hostile).unwrap_err();
    assert!(found.iter().all(|d| !d.message.contains('\u{202e}')));
    assert_eq!(found[0].field.as_deref(), Some("dates[0].note"));
    hostile["entries"][0]["dates"] =
        Value::Array(vec![cited("n", "birth", json!({"unknown": true})); 21]);
    assert_eq!(codes(&hostile), [Code::TooLarge]);
    hostile["entries"][0]["dates"] = json!({"id": "n"});
    assert_eq!(codes(&hostile), [Code::InvalidField]);
    hostile["entries"][0]["dates"] = json!([cited("n", "birth", json!("428 BCE"))]);
    assert_eq!(codes(&hostile), [Code::InvalidField]);

    // A change through the atlas is all or nothing.
    let library = library();
    let notebook = notebook(&library);
    let links = Links {
        library: &library,
        notebook: &notebook,
    };
    let mut atlas = parse(&atlas_with(json!([]))).unwrap();
    let before = atlas.clone();
    let entry = Entry::from_json(json!({"id": "plato", "kind": "person", "label": "Plato",
        "dates": [cited("d", "birth", json!({"relative": {"order": "after", "entry": "ghost", "aspect": "span"}}))]}))
    .expect("the entry reads on its own");
    let refused = atlas.upsert_entry(entry, links).unwrap_err();
    assert_eq!(refused[0].code, Code::UnknownEntry);
    assert_eq!(atlas, before);
    assert_eq!(
        Entry::from_json(json!({"id": "plato", "kind": "person", "label": "Plato",
            "dates": [cited("d", "birth", json!({"at": {"year": 0}}))]}))
        .unwrap_err()[0]
            .field
            .as_deref(),
        Some("dates[0].date.at.year")
    );
    let entry = Entry::from_json(json!({"id": "plato", "kind": "person", "label": "Plato",
        "dates": [cited("d", "birth", json!({"at": {"year": -428, "circa": true}}))]}))
    .unwrap();
    atlas.upsert_entry(entry, links).expect("a dated entry");
    assert!(atlas.entry("plato").unwrap().dates[0].date.form != DateForm::Unknown);
}

#[test]
fn version_1_bounds_upgrade_to_a_private_unsourced_dating_without_loss() {
    let v1 = json!({"version": 1,
        "entries": [
            {"id": "plato", "kind": "person", "label": "Plato",
             "bounds": {"from": -428, "until": -348, "circa": true}, "visibility": "approved"},
            {"id": "plato-span", "kind": "concept", "label": "Taken"},
            {"id": "republic", "kind": "work", "label": "Republic", "bounds": {"from": -380}},
            {"id": "phaedo", "kind": "work", "label": "Phaedo", "bounds": {"until": -360}},
            {"id": "forms", "kind": "concept", "label": "Forms", "bounds": {"note": "kept"}},
            {"id": "academy", "kind": "movement", "label": "Academy", "bounds": {}},
            {"id": "a-very-long-identifier-that-already-fills-sixty-four-bytes-xyzw",
             "kind": "event", "label": "Long", "bounds": {"from": 1}}],
        "relationships": []});
    let atlas = parse(&v1).expect("a version 1 atlas is read");
    assert_eq!(atlas.version, ATLAS_VERSION);
    let plato = atlas.entry("plato").unwrap();
    assert_eq!(
        plato.visibility,
        Visibility::Approved,
        "the entry is unchanged"
    );
    let migrated = &plato.dates[0];
    assert_eq!(migrated.id, "plato-span-2", "an unused id");
    assert_eq!(migrated.aspect, Aspect::Span);
    assert_eq!(
        migrated.date.form,
        DateForm::Span {
            from: Some(Point::year(-428)),
            to: Some(Point::year(-348))
        },
        "the years are kept exactly, with no invented precision or circa"
    );
    assert!(migrated.unsourced, "version 1 recorded no evidence");
    assert_eq!(
        migrated.visibility,
        Visibility::Private,
        "never published by an upgrade"
    );
    assert_eq!(migrated.extra["boundsExtra"], json!({"circa": true}));
    assert!(atlas.projected_datings().is_empty());
    assert_eq!(
        atlas.entry("republic").unwrap().dates[0].date.form,
        DateForm::Span {
            from: Some(Point::year(-380)),
            to: None
        }
    );
    match &atlas.entry("phaedo").unwrap().dates[0].date.form {
        DateForm::Span {
            from: None,
            to: Some(p),
        } => {
            assert_eq!(
                p.stated,
                Stated::Year {
                    year: -360,
                    month: None,
                    day: None
                }
            )
        }
        other => panic!("{other:?}"),
    }
    let forms = atlas.entry("forms").unwrap();
    assert!(forms.dates.is_empty(), "no years, so nothing is dated");
    assert_eq!(forms.extra["boundsExtra"], json!({"note": "kept"}));
    assert!(atlas.entry("academy").unwrap().dates.is_empty());
    assert!(!atlas
        .entry("academy")
        .unwrap()
        .extra
        .contains_key("boundsExtra"));
    let long = &atlas.entries[6].dates[0].id;
    assert!(long.len() <= 64 && long.ends_with("-span"), "{long}");

    let written = atlas.to_json();
    assert!(written.starts_with("{\n  \"version\": 2,"));
    assert!(!written.contains("\"bounds\""));
    let reread = parse(&serde_json::from_str(&written).unwrap()).unwrap();
    assert_eq!(reread, atlas, "the upgrade is idempotent once written");

    // A version 1 file that already uses the new name is refused, not misread.
    let mut clash = v1.clone();
    clash["entries"][5]["dates"] = json!(["1999"]);
    let found = parse(&clash).unwrap_err();
    assert_eq!(found[0].code, Code::InvalidField);
    assert_eq!(found[0].field.as_deref(), Some("dates"));
    // Invalid version 1 bounds are reported in version 1's terms.
    let mut broken = v1.clone();
    broken["entries"][2]["bounds"] = json!({"from": 0, "until": -5});
    let found = parse(&broken).unwrap_err();
    assert_eq!(found[0].field.as_deref(), Some("bounds.from"));
    assert_eq!(found[0].index, Some(2));
    // Version 2 has no `bounds`.
    let mut v2 = reread_value(&written);
    v2["entries"][2]["bounds"] = json!({"from": -380});
    let found = parse(&v2).unwrap_err();
    assert_eq!(
        (found[0].code, found[0].field.as_deref()),
        (Code::InvalidField, Some("bounds"))
    );
    assert_eq!(codes(&json!({"version": 3})), [Code::UnsupportedVersion]);
    assert_eq!(codes(&json!({"version": 0})), [Code::UnsupportedVersion]);
}

fn reread_value(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn approval_follows_the_atlas_projection_and_withdrawal_is_an_edit() {
    let approved = |id: &str, date: Value| {
        let mut dating = cited(id, "span", date);
        dating["visibility"] = json!("approved");
        dating
    };
    let mut value = atlas_with(json!([
        approved(
            "plato-life",
            json!({"from": {"year": -428}, "to": {"year": -348}})
        ),
        approved(
            "plato-rel",
            json!({"relative": {"order": "during", "entry": "academy", "aspect": "span"}})
        ),
        cited("plato-private", "birth", json!({"at": {"year": -428}})),
    ]));
    value["entries"][0]["visibility"] = json!("approved");
    value["entries"][1]["visibility"] = json!("approved");
    value["relationships"][0]["visibility"] = json!("approved");
    value["relationships"][0]["dates"] = json!([approved("held", json!({"at": {"decade": -380}}))]);
    let atlas = parse(&value).unwrap();
    let projected = |atlas: &Atlas| -> Vec<String> {
        atlas
            .projected_datings()
            .iter()
            .map(|(_, d)| d.id.clone())
            .collect()
    };
    assert_eq!(
        projected(&atlas),
        ["plato-life", "held"],
        "a relative dating to a private entry and a private dating stay out"
    );
    let notices: Vec<(Option<String>, Option<String>)> = atlas
        .notices()
        .into_iter()
        .map(|n| (n.id, n.field))
        .collect();
    assert_eq!(
        notices,
        [(
            Some("plato".to_string()),
            Some("dates[1].date.relative.entry".to_string())
        )]
    );

    // Withdrawing the entry withdraws its datings and the relationship's.
    let mut withdrawn = value.clone();
    withdrawn["entries"][0]["visibility"] = json!("private");
    let atlas = parse(&withdrawn).expect("withdrawal never makes the atlas invalid");
    assert!(projected(&atlas).is_empty());
    assert!(atlas
        .notices()
        .iter()
        .all(|n| n.code == Code::PrivateEndpoint));
    assert!(atlas
        .notices()
        .iter()
        .any(|n| n.id.as_deref() == Some("r-authored") && n.field.as_deref() == Some("dates[0]")));
    // Approving the target restores the relative dating.
    let mut restored = value;
    restored["entries"][3]["visibility"] = json!("approved");
    let atlas = parse(&restored).unwrap();
    assert_eq!(projected(&atlas), ["plato-life", "plato-rel", "held"]);
    assert!(atlas.notices().is_empty());
}
