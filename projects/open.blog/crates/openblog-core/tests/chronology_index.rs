//! The chronology index and its structural prompts (ADR 0096, ADR 0097):
//! sorting is deterministic across partial, open, BCE, tied, unknown and
//! relative datings whatever the file order; competing datings stay side by
//! side; prompts explain the authored contradiction with its stated values,
//! name ids only, are scoped to one item and never judge which dating is
//! right; and closeness in time never becomes a relationship.

use std::collections::BTreeMap;

use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::chronology::Aspect;
use openblog_core::chronology_index::{
    ChronologyIndex, ChronologyPrompt, ChronologyPromptCode as P, MAX_CHRONOLOGY_PROMPTS,
};
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use serde_json::{json, Value};

/// Authored text the prompts must never repeat.
const SECRET: &str = "ob-chronology-secret";

fn library() -> SourceLibrary {
    let text = json!({"version": 1, "sources": [
        {"id": "diogenes", "kind": "work", "title": "Lives"},
        {"id": "nails-2002", "kind": "work", "title": "The People of Plato"},
        {"id": "plato-republic", "kind": "work", "title": "Politeia"}
    ]})
    .to_string();
    SourceLibrary::parse(&text, &BTreeMap::new()).expect("library")
}

fn parse(value: &Value) -> Atlas {
    let library = library();
    Atlas::parse(
        &value.to_string(),
        Links {
            library: &library,
            notebook: &Notebook::default(),
        },
    )
    .unwrap_or_else(|diagnostics| panic!("valid atlas: {diagnostics:?}"))
}

/// A dating cited by `source`, which is also the party that gives it.
fn by(source: &str, id: &str, aspect: &str, date: Value) -> Value {
    json!({"id": id, "aspect": aspect, "date": date,
        "assertedBy": {"kind": "source", "source": source},
        "evidence": [{"source": source}],
        "note": format!("{SECRET} note"), "shelf": format!("{SECRET} extra")})
}

fn dl(id: &str, aspect: &str, date: Value) -> Value {
    by("diogenes", id, aspect, date)
}

fn at(year: i32) -> Value {
    json!({"at": {"year": year}})
}

fn rel(order: &str, entry: &str, aspect: &str) -> Value {
    json!({"relative": {"order": order, "entry": entry, "aspect": aspect}})
}

fn entry(id: &str, kind: &str, dates: Value) -> Value {
    json!({"id": id, "kind": kind, "label": format!("{SECRET} label {id}"), "dates": dates})
}

fn atlas_of(entries: Vec<Value>, relationships: Vec<Value>) -> Value {
    json!({"version": 2, "entries": entries, "relationships": relationships})
}

fn authored(id: &str, from: &str, to: &str) -> Value {
    json!({"id": id, "kind": "authored", "from": from, "to": to,
        "assertedBy": {"kind": "named", "name": format!("{SECRET} party")},
        "evidence": [{"source": "plato-republic"}],
        "uncertainty": format!("{SECRET} doubt")})
}

fn codes(index: &ChronologyIndex) -> Vec<(P, Vec<&str>)> {
    index
        .prompts
        .iter()
        .map(|p| (p.code, p.datings.iter().map(String::as_str).collect()))
        .collect()
}

/// Every prompt names ids and stated values only, asks for a check, never
/// rules, and is scoped to the item that owns the dating it starts from.
fn assert_prompts_are_bounded(atlas: &Atlas, index: &ChronologyIndex) {
    for prompt in &index.prompts {
        let shown = prompt.to_string();
        assert!(!shown.contains(SECRET), "{shown}");
        assert!(shown.contains("check"), "{shown}");
        assert!(shown.contains("as recorded"), "{shown}");
        for verdict in [
            "wrong",
            "incorrect",
            "error",
            "invalid",
            "influence",
            "correct",
            "should be",
        ] {
            assert!(
                !shown.to_lowercase().contains(verdict),
                "{verdict}: {shown}"
            );
        }
        assert_scoped(atlas, prompt);
    }
}

fn assert_scoped(atlas: &Atlas, prompt: &ChronologyPrompt) {
    let position: usize = prompt
        .field
        .strip_prefix("dates[")
        .and_then(|rest| rest.strip_suffix(']'))
        .and_then(|n| n.parse().ok())
        .expect("a dating field");
    let (id, dates) = match prompt.collection {
        "entries" => {
            let e = &atlas.entries[prompt.index];
            (&e.id, &e.dates)
        }
        "relationships" => {
            let r = &atlas.relationships[prompt.index];
            (&r.id, &r.dates)
        }
        other => panic!("unexpected collection {other}"),
    };
    assert_eq!(id, &prompt.id);
    assert_eq!(dates[position].id, prompt.datings[0], "{prompt}");
}

/// The index fields that must not depend on file order.
fn order_free(index: &ChronologyIndex) -> impl PartialEq + std::fmt::Debug {
    (
        index.datings.clone(),
        index.by_owner.clone(),
        index.by_aspect.clone(),
        index.by_time.clone(),
        index.relative_to.clone(),
        index
            .prompts
            .iter()
            .map(|p| (p.code, p.id.clone(), p.datings.clone(), p.message.clone()))
            .collect::<Vec<_>>(),
    )
}

fn timeline() -> Value {
    atlas_of(
        vec![
            entry(
                "plato",
                "person",
                json!([
                    dl(
                        "plato-birth-circa",
                        "birth",
                        json!({"at": {"year": -428, "circa": true}})
                    ),
                    by("nails-2002", "plato-birth-424", "birth", at(-424)),
                    dl(
                        "plato-death-window",
                        "death",
                        json!({"notBefore": {"year": -348}, "notAfter": {"year": -347}})
                    ),
                    by(
                        "nails-2002",
                        "plato-death-unknown",
                        "death",
                        json!({"unknown": true})
                    ),
                    dl("plato-active", "active", json!({"from": {"decade": -390}})),
                    dl(
                        "plato-span",
                        "span",
                        json!({"from": {"century": -5}, "to": {"century": -4}})
                    )
                ]),
            ),
            entry(
                "republic",
                "work",
                json!([
                    dl(
                        "republic-composed",
                        "composition",
                        json!({"notAfter": {"year": -370}})
                    ),
                    dl(
                        "republic-after-phaedo",
                        "composition",
                        rel("after", "phaedo", "composition")
                    )
                ]),
            ),
            entry("phaedo", "work", json!([])),
            entry(
                "augustine",
                "person",
                json!([
                    dl(
                        "augustine-birth",
                        "birth",
                        json!({"at": {"year": 354, "month": 11, "day": 13}})
                    ),
                    dl(
                        "augustine-birth-tie",
                        "birth",
                        json!({"at": {"year": 354, "month": 11, "day": 13, "calendar": "julian"}})
                    )
                ]),
            ),
            entry(
                "jesus",
                "person",
                json!([
                    dl(
                        "era-1-bce",
                        "birth",
                        json!({"notBefore": {"year": -1}, "notAfter": {"year": -1}})
                    ),
                    by(
                        "nails-2002",
                        "era-1-ce",
                        "birth",
                        json!({"notBefore": {"year": 1}, "notAfter": {"year": 1}})
                    )
                ]),
            ),
        ],
        vec![],
    )
}

#[test]
fn sorting_is_deterministic_across_partial_dates() {
    let value = timeline();
    let atlas = parse(&value);
    let index = ChronologyIndex::of(&atlas);
    assert_eq!(
        index.by_time,
        [
            // An open start comes before every year.
            "republic-composed",
            // The 5th century BCE begins in 500 BCE.
            "plato-span",
            // Circa does not move a point.
            "plato-birth-circa",
            "plato-birth-424",
            // The 390s BCE are 399 to 390 BCE.
            "plato-active",
            "plato-death-window",
            // No year 0: 1 BCE is directly followed by 1 CE.
            "era-1-bce",
            "era-1-ce",
            // The same day stated twice ties, and the tie is broken by id.
            "augustine-birth",
            "augustine-birth-tie",
            // Relative datings follow every absolute one, unknown ones come last.
            "republic-after-phaedo",
            "plato-death-unknown",
        ]
    );
    assert_eq!(index.datings.len(), 12, "no dating is dropped");
    assert!(index.prompts.is_empty(), "{:?}", index.prompts);

    // Reversing every list in the file changes nothing in the index.
    let mut reversed = value.clone();
    let entries = reversed["entries"].as_array_mut().unwrap();
    entries.reverse();
    for entry in entries.iter_mut() {
        entry["dates"].as_array_mut().unwrap().reverse();
    }
    assert_eq!(
        order_free(&ChronologyIndex::of(&parse(&reversed))),
        order_free(&index)
    );
    // Nor does any rotation of the entries, or of each entry's datings.
    for shift in 1..5 {
        let mut rotated = value.clone();
        let entries = rotated["entries"].as_array_mut().unwrap();
        let len = entries.len();
        entries.rotate_left(shift % len);
        for entry in entries.iter_mut() {
            let dates = entry["dates"].as_array_mut().unwrap();
            if !dates.is_empty() {
                let by = shift % dates.len();
                dates.rotate_left(by);
            }
        }
        assert_eq!(
            order_free(&ChronologyIndex::of(&parse(&rotated))),
            order_free(&index),
            "rotation {shift}"
        );
    }
    // And the same atlas always gives the same index.
    assert_eq!(ChronologyIndex::of(&atlas), index);
}

#[test]
fn competing_datings_stay_side_by_side_by_entry_aspect_and_time() {
    let atlas = parse(&timeline());
    let index = ChronologyIndex::of(&atlas);
    assert_eq!(
        index.competing("plato", Aspect::Birth),
        ["plato-birth-circa", "plato-birth-424"]
    );
    assert_eq!(
        index.competing("plato", Aspect::Death),
        ["plato-death-window", "plato-death-unknown"],
        "an unknown dating competes with a dated one and is kept"
    );
    assert_eq!(
        index.competing("republic", Aspect::Composition),
        ["republic-composed", "republic-after-phaedo"]
    );
    assert_eq!(
        index.by_aspect[&Aspect::Birth],
        [
            "plato-birth-circa",
            "plato-birth-424",
            "era-1-bce",
            "era-1-ce",
            "augustine-birth",
            "augustine-birth-tie"
        ]
    );
    assert_eq!(index.relative_to["phaedo"], ["republic-after-phaedo"]);
    // An entry with no datings is simply undated: it has no index entry.
    assert!(index.competing("phaedo", Aspect::Composition).is_empty());
    assert!(!index.by_owner.contains_key("phaedo"));
    let placed = &index.datings["plato-birth-424"];
    assert_eq!(
        (placed.owner.as_str(), placed.aspect),
        ("plato", Aspect::Birth)
    );
}

#[test]
fn an_atlas_without_datings_indexes_nothing_and_prompts_nothing() {
    let atlas = parse(&atlas_of(
        vec![
            entry("plato", "person", json!([])),
            entry("republic", "work", json!([])),
        ],
        vec![authored("r", "plato", "republic")],
    ));
    assert_eq!(ChronologyIndex::of(&atlas), ChronologyIndex::default());
    assert_eq!(
        ChronologyIndex::of(&Atlas::default()),
        ChronologyIndex::default()
    );
}

#[test]
fn a_death_before_birth_is_a_prompt_with_the_cited_values() {
    let atlas = parse(&atlas_of(
        vec![entry(
            "plato",
            "person",
            json!([
                dl("born", "birth", json!({"notBefore": {"year": -400}})),
                by(
                    "nails-2002",
                    "died",
                    "death",
                    json!({"notAfter": {"year": -410, "circa": true}})
                )
            ]),
        )],
        vec![],
    ));
    let index = ChronologyIndex::of(&atlas);
    assert_eq!(codes(&index), [(P::DeathBeforeBirth, vec!["died", "born"])]);
    let prompt = &index.prompts[0];
    assert_eq!(
        prompt.to_string(),
        "entries[0] `plato` dates[1]: death dating `died` (not after c. 410 BCE) ends before birth dating `born` (not before 400 BCE) can begin, so as recorded they cannot both hold. They come from different parties: check the values against the cited evidence; a recorded disagreement can stay side by side as it is. (death-before-birth)"
    );
    assert_prompts_are_bounded(&atlas, &index);
}

#[test]
fn overlapping_and_open_ranges_are_never_prompts() {
    let cases = [
        // Windows that overlap by one year.
        (
            json!({"notBefore": {"year": -400}, "notAfter": {"year": -390}}),
            json!({"notBefore": {"year": -390}, "notAfter": {"year": -350}}),
        ),
        // A death with an open start, a birth with an open end.
        (
            json!({"notAfter": {"year": -500}}),
            json!({"notBefore": {"year": -600}}),
        ),
        // Coarser precision covers the finer date.
        (
            json!({"at": {"century": -4}}),
            json!({"at": {"year": -399}}),
        ),
        (
            json!({"at": {"decade": -380}}),
            json!({"at": {"year": -385}}),
        ),
        // The same year in different calendars: only years are compared.
        (
            json!({"at": {"year": 1600, "month": 12, "day": 31, "calendar": "gregorian"}}),
            json!({"at": {"year": 1600, "month": 1, "day": 1, "calendar": "julian"}}),
        ),
        // Unknown and relative datings have no extent to compare.
        (json!({"unknown": true}), json!({"at": {"year": -399}})),
    ];
    for (birth, death) in cases {
        let atlas = parse(&atlas_of(
            vec![entry(
                "plato",
                "person",
                json!([
                    dl("born", "birth", birth.clone()),
                    dl("died", "death", death.clone())
                ]),
            )],
            vec![],
        ));
        let index = ChronologyIndex::of(&atlas);
        assert!(
            index.prompts.is_empty(),
            "{birth} {death}: {:?}",
            index.prompts
        );
    }
    // In the same calendar, months and days count.
    let atlas = parse(&atlas_of(
        vec![entry(
            "p",
            "person",
            json!([
                dl(
                    "born",
                    "birth",
                    json!({"at": {"year": 1600, "month": 12, "day": 31, "calendar": "julian"}})
                ),
                dl(
                    "died",
                    "death",
                    json!({"at": {"year": 1600, "month": 1, "day": 1, "calendar": "julian"}})
                )
            ]),
        )],
        vec![],
    ));
    assert_eq!(
        codes(&ChronologyIndex::of(&atlas)),
        [(P::DeathBeforeBirth, vec!["died", "born"])]
    );
    // BCE meets CE with no year 0: a death in 1 BCE is before a birth in 1 CE.
    let atlas = parse(&atlas_of(
        vec![entry(
            "p",
            "person",
            json!([dl("born", "birth", at(1)), dl("died", "death", at(-1))]),
        )],
        vec![],
    ));
    let index = ChronologyIndex::of(&atlas);
    assert!(index.prompts[0]
        .message
        .contains("(1 BCE) ends before birth dating `born` (1 CE)"));
}

#[test]
fn works_and_lives_across_an_authored_relationship() {
    let value = atlas_of(
        vec![
            entry(
                "plato",
                "person",
                json!([
                    dl(
                        "plato-born",
                        "birth",
                        json!({"at": {"year": -428, "circa": true}})
                    ),
                    dl("plato-died", "death", at(-348)),
                    dl("plato-active", "active", json!({"from": {"year": -340}}))
                ]),
            ),
            entry(
                "laws",
                "work",
                json!([
                    by(
                        "nails-2002",
                        "laws-late",
                        "composition",
                        json!({"from": {"year": -340}, "to": {"year": -330}})
                    ),
                    dl("laws-early", "composition", json!({"to": {"year": -500}})),
                    dl(
                        "laws-published",
                        "publication",
                        json!({"notAfter": {"year": -600}})
                    )
                ]),
            ),
        ],
        vec![authored("plato-wrote-laws", "plato", "laws")],
    );
    let atlas = parse(&value);
    let index = ChronologyIndex::of(&atlas);
    assert_eq!(
        codes(&index),
        [
            (P::CompositionBeforeBirth, vec!["laws-early", "plato-born"]),
            (P::CompositionAfterDeath, vec!["laws-late", "plato-died"]),
            // `laws-early` has an open start, so a publication before 600
            // BCE could still follow it; only `laws-late` cannot.
            (
                P::PublicationBeforeComposition,
                vec!["laws-published", "laws-late"]
            ),
            (P::OutsideLifetime, vec!["plato-active", "plato-died"]),
        ]
    );
    let after_death = index
        .prompts
        .iter()
        .find(|p| p.code == P::CompositionAfterDeath)
        .unwrap();
    assert_eq!(
        after_death.message,
        "composition dating `laws-late` (from 340 BCE to 330 BCE) begins after `plato`'s death dating `plato-died` (348 BCE) ends, while relationship `plato-wrote-laws` records `plato` as its author, so as recorded they cannot all hold. They come from different parties: check the values against the cited evidence; a recorded disagreement can stay side by side as it is."
    );
    assert_eq!(
        (after_death.collection, after_death.id.as_str()),
        ("entries", "laws")
    );
    assert_prompts_are_bounded(&atlas, &index);

    // Without the authored relationship, a work dated after a death is no
    // prompt: nothing links them, and dates never do.
    let mut unrelated = value.clone();
    unrelated["relationships"] = json!([]);
    let index = ChronologyIndex::of(&parse(&unrelated));
    assert!(index
        .prompts
        .iter()
        .all(|p| !matches!(p.code, P::CompositionAfterDeath | P::CompositionBeforeBirth)));
}

#[test]
fn two_parties_recording_the_same_author_give_prompts_in_a_fixed_order() {
    let value = |relationships: Vec<Value>| {
        atlas_of(
            vec![
                entry(
                    "plato",
                    "person",
                    json!([dl("plato-died", "death", at(-348))]),
                ),
                entry(
                    "laws",
                    "work",
                    json!([dl("laws-late", "composition", at(-300))]),
                ),
            ],
            relationships,
        )
    };
    let mut second = authored("b-wrote-laws", "plato", "laws");
    second["assertedBy"] = json!({"kind": "source", "source": "nails-2002"});
    let first = authored("a-wrote-laws", "plato", "laws");
    let forward = ChronologyIndex::of(&parse(&value(vec![first.clone(), second.clone()])));
    let backward = ChronologyIndex::of(&parse(&value(vec![second, first])));
    // Both prompts share the item, the datings and the code, and differ only
    // in the relationship they name; neither is dropped, and the order is the
    // same whichever relationship the file lists first.
    assert_eq!(forward.prompts.len(), 2);
    assert!(forward.prompts[0].message.contains("`a-wrote-laws`"));
    assert!(forward.prompts[1].message.contains("`b-wrote-laws`"));
    assert_eq!(forward.prompts, backward.prompts);
}

#[test]
fn a_relationship_dated_outside_a_life_it_needs_is_a_prompt_but_influence_is_not() {
    let value = |kind: &str, from: &str, to: &str| {
        atlas_of(
            vec![
                entry(
                    "plato",
                    "person",
                    json!([dl(
                        "plato-life",
                        "span",
                        json!({"from": {"year": -428}, "to": {"year": -348}})
                    )]),
                ),
                entry("academy", "movement", json!([])),
                entry("plotinus", "person", json!([])),
            ],
            vec![json!({"id": "r", "kind": kind, "from": from, "to": to,
                "assertedBy": {"kind": "author"}, "evidence": [{"source": "diogenes"}],
                "dates": [dl("r-held", "span", json!({"from": {"year": 250}}))]})],
        )
    };
    let atlas = parse(&value("member-of", "plato", "academy"));
    let index = ChronologyIndex::of(&atlas);
    assert_eq!(
        codes(&index),
        [(P::OutsideLifetime, vec!["r-held", "plato-life"])]
    );
    assert_eq!(index.prompts[0].collection, "relationships");
    assert!(index.prompts[0]
        .message
        .contains("this `member-of` relationship needs `plato` alive"));
    assert_prompts_are_bounded(&atlas, &index);
    // Influence can outlive a person, so it is never measured against a life.
    let index = ChronologyIndex::of(&parse(&value("influenced", "plato", "plotinus")));
    assert!(index.prompts.is_empty(), "{:?}", index.prompts);
}

#[test]
fn opposed_relative_datings_and_loops_are_prompts_never_resolved() {
    let value = atlas_of(
        vec![
            entry(
                "republic",
                "work",
                json!([dl(
                    "rep-after-phaedo",
                    "composition",
                    rel("after", "phaedo", "composition")
                )]),
            ),
            entry(
                "phaedo",
                "work",
                json!([
                    by(
                        "nails-2002",
                        "phaedo-after-rep",
                        "composition",
                        rel("after", "republic", "composition")
                    ),
                    dl(
                        "phaedo-during-rep",
                        "composition",
                        rel("during", "republic", "composition")
                    )
                ]),
            ),
            entry(
                "a",
                "work",
                json!([dl(
                    "a-before-b",
                    "composition",
                    rel("before", "b", "composition")
                )]),
            ),
            entry(
                "b",
                "work",
                json!([dl(
                    "b-before-c",
                    "composition",
                    rel("before", "c", "composition")
                )]),
            ),
            entry(
                "c",
                "work",
                json!([dl(
                    "c-before-a",
                    "composition",
                    rel("before", "a", "composition")
                )]),
            ),
        ],
        vec![],
    );
    let atlas = parse(&value);
    let before = atlas.clone();
    let index = ChronologyIndex::of(&atlas);
    assert_eq!(
        codes(&index),
        [
            (
                P::RelativeCycle,
                vec!["a-before-b", "b-before-c", "c-before-a"]
            ),
            (
                P::OpposedRelative,
                vec!["phaedo-after-rep", "phaedo-during-rep"]
            ),
            (
                P::OpposedRelative,
                vec!["phaedo-after-rep", "rep-after-phaedo"]
            ),
            (
                P::OpposedRelative,
                vec!["phaedo-during-rep", "rep-after-phaedo"]
            ),
        ]
    );
    let opposed = &index.prompts[2];
    assert_eq!(
        opposed.message,
        "relative dating `phaedo-after-rep` (`phaedo` composition after `republic` composition) and relative dating `rep-after-phaedo` (`republic` composition after `phaedo` composition) order the same two aspects in ways that cannot both hold as recorded. They come from different parties: check the values against the cited evidence; a recorded disagreement can stay side by side as it is."
    );
    assert!(index.prompts[0].message.starts_with(
        "relative datings `a-before-b`, `b-before-c` and `c-before-a` order `a` composition, `b` composition and `c` composition in a loop"
    ));
    assert_prompts_are_bounded(&atlas, &index);
    assert_eq!(atlas, before, "indexing never changes the atlas");
    // A chain is no loop, and agreeing relative datings are no prompt.
    let mut chain = value.clone();
    chain["entries"][4]["dates"] = json!([]);
    chain["entries"][1]["dates"] = json!([by(
        "nails-2002",
        "phaedo-before-rep",
        "composition",
        rel("before", "republic", "composition")
    )]);
    assert!(ChronologyIndex::of(&parse(&chain)).prompts.is_empty());
}

#[test]
fn a_relative_dating_against_absolute_datings_is_a_prompt() {
    let atlas = parse(&atlas_of(
        vec![
            entry(
                "republic",
                "work",
                json!([
                    dl(
                        "rep-before-phaedo",
                        "composition",
                        rel("before", "phaedo", "composition")
                    ),
                    dl(
                        "rep-composed",
                        "composition",
                        json!({"from": {"year": -375}, "to": {"year": -370}})
                    ),
                    dl(
                        "rep-composed-later",
                        "composition",
                        json!({"from": {"year": -360}})
                    )
                ]),
            ),
            entry(
                "phaedo",
                "work",
                json!([dl(
                    "phaedo-composed",
                    "composition",
                    json!({"to": {"year": -380}})
                )]),
            ),
        ],
        vec![],
    ));
    let index = ChronologyIndex::of(&atlas);
    assert_eq!(
        codes(&index),
        [(
            P::RelativeAgainstDates,
            vec![
                "rep-before-phaedo",
                "rep-composed",
                "phaedo-composed",
                "rep-composed-later"
            ]
        )]
    );
    assert_eq!(
        index.prompts[0].message,
        "relative dating `rep-before-phaedo` (`republic` composition before `phaedo` composition) disagrees with absolute datings: `republic`'s composition dating `rep-composed` (from 375 BCE to 370 BCE) begins after `phaedo`'s composition dating `phaedo-composed` (until 380 BCE) ends, and 1 other pair of absolute datings disagree the same way, so as recorded they cannot all hold. They come from the same party: check the values against the cited evidence."
    );
    assert_prompts_are_bounded(&atlas, &index);
}

#[test]
fn temporal_proximity_never_becomes_inferred_influence() {
    // Two contemporaries dated to the same years, with no relationship.
    let value = atlas_of(
        vec![
            entry(
                "plato",
                "person",
                json!([dl(
                    "plato-life",
                    "span",
                    json!({"from": {"year": -428}, "to": {"year": -348}})
                )]),
            ),
            entry(
                "xenophon",
                "person",
                json!([dl(
                    "xen-life",
                    "span",
                    json!({"from": {"year": -430}, "to": {"year": -354}})
                )]),
            ),
            entry(
                "republic",
                "work",
                json!([dl("rep", "composition", json!({"at": {"decade": -380}}))]),
            ),
            entry(
                "cyropaedia",
                "work",
                json!([dl("cyr", "composition", json!({"at": {"decade": -370}}))]),
            ),
        ],
        vec![],
    );
    let atlas = parse(&value);
    let index = ChronologyIndex::of(&atlas);
    assert!(index.prompts.is_empty());
    assert!(atlas.relationships.is_empty(), "no relationship is created");
    for id in ["plato", "xenophon", "republic", "cyropaedia"] {
        assert!(atlas.relationships_of(id).is_empty());
        assert!(!index.relative_to.contains_key(id), "no order is inferred");
    }
    // The timeline places them side by side and says nothing about them.
    assert_eq!(index.by_time, ["xen-life", "plato-life", "rep", "cyr"]);
    // A relationship asserted between them is unchanged by the index.
    let mut related = value.clone();
    related["relationships"] = json!([{"id": "infl", "kind": "influenced", "from": "plato",
        "to": "xenophon", "assertedBy": {"kind": "author"}, "unsourced": true}]);
    let related = parse(&related);
    let before = related.relationships.clone();
    let indexed = ChronologyIndex::of(&related);
    assert_eq!(related.relationships, before);
    assert!(indexed.prompts.is_empty());
    assert_eq!(indexed.by_time, index.by_time);
}

#[test]
fn prompts_beyond_the_limit_are_counted_not_listed() {
    // Eleven people, each with ten births after ten deaths: 1,100 prompts.
    let entries: Vec<Value> = (0..11)
        .map(|n| {
            let mut dates = Vec::new();
            for k in 0..10 {
                dates.push(dl(&format!("p{n}-born-{k}"), "birth", at(100 + k)));
                dates.push(dl(&format!("p{n}-died-{k}"), "death", at(-100 - k)));
            }
            entry(&format!("p{n}"), "person", Value::Array(dates))
        })
        .collect();
    let atlas = parse(&atlas_of(entries, vec![]));
    let index = ChronologyIndex::of(&atlas);
    assert_eq!(index.prompts.len(), MAX_CHRONOLOGY_PROMPTS);
    assert_eq!(index.unlisted, 100);
    assert!(index.prompts.windows(2).all(|w| w[0].id <= w[1].id));
}

#[test]
fn prompts_never_reach_the_public_projection_and_conflicting_datings_publish_side_by_side() {
    let value = |dates: Value| {
        json!({"version": 2,
            "entries": [
                {"id": "plato", "kind": "person", "label": "Plato", "visibility": "approved", "dates": dates},
                {"id": "republic", "kind": "work", "label": "Republic", "source": "plato-republic", "visibility": "approved"}],
            "relationships": [
                {"id": "r", "kind": "authored", "from": "plato", "to": "republic",
                 "assertedBy": {"kind": "author"}, "evidence": [{"source": "plato-republic"}],
                 "visibility": "approved"}]})
    };
    let mut born = dl("born", "birth", at(-400));
    born["visibility"] = json!("approved");
    let mut died = dl("died", "death", at(-410));
    died["visibility"] = json!("approved");
    let conflicting = parse(&value(json!([born, died])));
    assert!(!ChronologyIndex::of(&conflicting).prompts.is_empty());
    let library = library();
    let public = PublicAtlas::project(&conflicting, &library).unwrap();
    // Both datings are published as recorded; the prompt about them is not,
    // and nothing says which is right.
    assert_eq!(
        public
            .datings
            .iter()
            .map(|d| d.id.as_str())
            .collect::<Vec<_>>(),
        ["died", "born"]
    );
    let text = public.to_json();
    for absent in ["prompt", "death-before-birth", "check", "conflict"] {
        assert!(!text.contains(absent), "{absent} in {text}");
    }
}
