//! The public Knowledge Atlas: the one projection of approved atlas items that
//! every public representation reads (ADR 0058).
//!
//! [`PublicAtlas`] is built from an explicit allowlist. It copies only entries
//! the author approved and only relationships [`Atlas::is_projected`] lets
//! through (approved, sourced, no notebook passage, both entries approved),
//! and from them only the fields named here. Unknown fields, visibility, the
//! unsourced flag, notebook passage pointers, private notes and every
//! unapproved item have no place in these types, so they cannot reach a page
//! or the JSON artifact. Static pages and `atlas.json` are both rendered from
//! this value; nothing public reads the private atlas directly.
//!
//! Nothing here claims a relationship is true or agreed. Each one keeps who
//! asserts it, on what evidence, with what confidence and doubt, and its
//! derived standing: `asserted`, or `contested` with every dissenting party.
//!
//! Datings are copied the same way (ADR 0099): only those
//! [`Atlas::is_dating_projected`] lets through, each with who dates it, on
//! what evidence, how firmly and with what note, at the precision it states.
//! Competing datings of one aspect are all kept, side by side, and nothing
//! here picks, merges or orders them except for display.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::bibliography::CitationLocale;
use crate::chronology::{
    chronological, Aspect, Calendar, ChronoKey, DateForm, Dating, Point, Stated, TemporalOrder,
};
use crate::chronology_index::date_text;
use crate::citations::{format_reference, public_reference, PublicLocator, PublicReference};
use crate::knowledge_atlas::{
    Atlas, Attribution, AttributionKind, Confidence, Dissent, Entry, EntryKind, Evidence,
    Relationship, RelationshipKind, Standing,
};
use crate::source_library::SourceLibrary;

/// Names the public artifact. Deliberately not the private atlas's shape: it
/// has no `version` key, so it is never mistaken for private research.
pub const PUBLIC_ATLAS_FORMAT: &str = "openblog-atlas-projection";
/// The only public atlas format version this release writes.
pub const PUBLIC_ATLAS_FORMAT_VERSION: u64 = 1;
/// Where the atlas pages live on the site.
pub const ATLAS_URL: &str = "/atlas/";
/// The JSON artifact, relative to the site root.
pub const ATLAS_JSON_FILE: &str = "atlas.json";

/// The published atlas: approved entries, projected relationships, and the
/// public description of every source they cite or attribute to.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAtlas {
    pub format: &'static str,
    pub format_version: u64,
    /// Sorted by id.
    pub entries: Vec<PublicEntry>,
    /// Sorted by id.
    pub relationships: Vec<PublicRelationship>,
    /// Sorted by id; each one is cited, attributed or stood for by an item above.
    pub sources: Vec<PublicSource>,
    /// Every projected dating in the chronology's one display order
    /// (`chronology::chronological`: earliest then latest stated day, then
    /// relative datings, then unknown ones, ties broken by id). Absent from
    /// the JSON when there are none, so an atlas without published datings
    /// is written exactly as before.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub datings: Vec<PublicDating>,
}

/// One party's published claim about when an aspect of a published entry or
/// relationship happened. Never a fact and never the only date: competing
/// datings of the same aspect are published beside it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicDating {
    pub id: String,
    /// The entry or relationship it dates.
    pub owner: String,
    pub owner_type: OwnerType,
    pub aspect: Aspect,
    pub date: PublicDate,
    /// The date read back in words at its own precision, with BCE written
    /// out: "not before the 420s BCE", "after the composition of Phaedo".
    pub text: String,
    pub placement: Placement,
    /// The first year an absolute dating covers; absent for an open start, a
    /// relative or an unknown dating.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_year: Option<i32>,
    /// The last year an absolute dating covers; absent for an open end, a
    /// relative or an unknown dating.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_year: Option<i32>,
    pub asserted_by: PublicParty,
    /// How firmly the dating party holds it, never how widely it is accepted.
    pub confidence: Confidence,
    /// Never empty: an unsourced draft is never projected.
    pub evidence: Vec<PublicEvidence>,
    /// The author's note: what is doubtful, how the party reckons the date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What a published dating dates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnerType {
    Entry,
    Relationship,
}

/// Where a dating can be placed: in time, only against another entry, or
/// nowhere because its party says the date is unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    Dated,
    Relative,
    Unknown,
}

/// A date expression as published: exactly one form, each point at the
/// precision it states. Unknown fields of the stored date have no place here.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicDate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<PublicPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<PublicPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<PublicPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_before: Option<PublicPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_after: Option<PublicPoint>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unknown: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative: Option<PublicRelative>,
}

/// One point at its stated precision: a year (with a month, and a day only
/// with a month), a decade or a century. Negative is BCE; there is no 0.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct PublicPoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub month: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decade: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub century: Option<i32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub circa: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar: Option<Calendar>,
}

/// Before, after or during another published entry's aspect: an asserted
/// order, never one derived from dates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicRelative {
    pub order: TemporalOrder,
    pub entry: String,
    pub aspect: Aspect,
}

/// One published item's datings of one aspect, in display order. With more
/// than one dating it holds competing datings, side by side; none is
/// preferred.
#[derive(Clone, Debug, PartialEq)]
pub struct DatedAspect<'a> {
    pub owner: &'a str,
    pub owner_type: OwnerType,
    pub aspect: Aspect,
    pub datings: Vec<&'a PublicDating>,
    /// Whether any of its datings is absolute, so it can be placed in time.
    pub placed: bool,
    /// The year its earliest absolute dating begins in; `None` for an open
    /// start or when it is not placed in time.
    pub start_year: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PublicEntry {
    pub id: String,
    pub kind: EntryKind,
    pub label: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Only on a work: the source-library work it stands for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The entry's canonical page, root-relative.
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicRelationship {
    pub id: String,
    /// The stored direction: `from` `kind` `to`. The reverse reading is only
    /// `inverseLabel`, never a second assertion.
    pub kind: RelationshipKind,
    pub from: String,
    pub to: String,
    /// How the relationship reads in words ("member of"); `kind` stays the
    /// machine value ("member-of").
    pub label: &'static str,
    pub inverse_label: &'static str,
    pub asserted_by: PublicParty,
    pub confidence: Confidence,
    /// Never empty: an unsourced draft is never projected.
    pub evidence: Vec<PublicEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
    /// Derived, never stored: `asserted`, or `contested` when anyone dissents.
    pub standing: Standing,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub contested_by: Vec<PublicDissent>,
}

/// Who holds a position: the site author, a source, or a named party.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicParty {
    pub kind: AttributionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A cited source and where in it. Never a notebook passage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicEvidence {
    pub source: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<PublicLocator>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicDissent {
    pub by: PublicParty,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<PublicEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A source's public description (the citation allowlist of ADR 0044) and its
/// deterministic plain-text rendering.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicSource {
    #[serde(flatten)]
    pub reference: PublicReference,
    pub text: String,
}

/// Compact JSON of a projection value with `<`, `>` and `&` written as
/// escapes, so authored text can never close a `<script>` element the data is
/// later embedded in.
pub(crate) fn escaped_json<T: Serialize>(value: &T) -> String {
    let json = serde_json::to_string(value).expect("a projection is serializable");
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        match c {
            '<' | '>' | '&' => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            _ => out.push(c),
        }
    }
    out
}

/// The canonical page of an entry. Entry ids are lowercase slugs, so they are
/// safe path segments as they are.
pub fn entry_url(id: &str) -> String {
    format!("{ATLAS_URL}{id}/")
}

impl PublicAtlas {
    /// Project the approved part of a validated atlas. The library supplies
    /// the public description of the sources the projected items use; the
    /// notebook is not an input. Fails, naming ids only, if a projected item
    /// uses a source the library does not hold.
    pub fn project(atlas: &Atlas, library: &SourceLibrary) -> Result<Self, String> {
        let (entries, relationships) = atlas.projected();
        let mut entries: Vec<PublicEntry> = entries.into_iter().map(public_entry).collect();
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        let mut relationships: Vec<PublicRelationship> =
            relationships.into_iter().map(public_relationship).collect();
        relationships.sort_by(|a, b| a.id.cmp(&b.id));

        // Re-check what the projection rests on rather than trusting it: a
        // relationship may only join entries this projection publishes.
        let published: BTreeSet<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        if let Some(r) = relationships
            .iter()
            .find(|r| !published.contains(r.from.as_str()) || !published.contains(r.to.as_str()))
        {
            return Err(format!(
                "the Knowledge Atlas relationship `{}` joins an entry that is not published",
                r.id
            ));
        }

        let mut used: BTreeMap<String, String> = BTreeMap::new();
        for entry in &entries {
            if let Some(source) = &entry.source {
                used.entry(source.clone())
                    .or_insert_with(|| entry.id.clone());
            }
        }
        for r in &relationships {
            for source in relationship_sources(r) {
                used.entry(source.to_string())
                    .or_insert_with(|| r.id.clone());
            }
        }
        // Datings, in the chronology's one display order. Each must date a
        // published item and point only at a published entry.
        let mut projected = atlas.projected_datings();
        projected.sort_by(|a, b| chronological(a.1, b.1));
        let labels: BTreeMap<&str, &str> = entries
            .iter()
            .map(|e| (e.id.as_str(), e.label.as_str()))
            .collect();
        let linked: BTreeSet<&str> = relationships.iter().map(|r| r.id.as_str()).collect();
        let mut datings = Vec::with_capacity(projected.len());
        for (owner, dating) in projected {
            let owner_type = if published.contains(owner) {
                OwnerType::Entry
            } else if linked.contains(owner) {
                OwnerType::Relationship
            } else {
                return Err(format!(
                    "the Knowledge Atlas dating `{}` dates an item that is not published",
                    dating.id
                ));
            };
            if dating
                .relative_target()
                .is_some_and(|target| !published.contains(target.entry.as_str()))
            {
                return Err(format!(
                    "the Knowledge Atlas dating `{}` is relative to an entry that is not published",
                    dating.id
                ));
            }
            datings.push(public_dating(owner, owner_type, dating, &labels));
        }
        for d in &datings {
            let party = d.asserted_by.source.as_deref();
            for source in d.evidence.iter().map(|e| e.source.as_str()).chain(party) {
                used.entry(source.to_string())
                    .or_insert_with(|| d.id.clone());
            }
        }

        let mut sources = Vec::with_capacity(used.len());
        for (id, user) in used {
            let Some(record) = library.get(&id) else {
                return Err(format!(
                    "the Knowledge Atlas item `{user}` uses the source `{id}`, which is not in the source library"
                ));
            };
            let reference = public_reference(record);
            let text = format_reference(&reference);
            sources.push(PublicSource { reference, text });
        }

        Ok(Self {
            format: PUBLIC_ATLAS_FORMAT,
            format_version: PUBLIC_ATLAS_FORMAT_VERSION,
            entries,
            relationships,
            sources,
            datings,
        })
    }

    pub fn relationship(&self, id: &str) -> Option<&PublicRelationship> {
        self.relationships
            .binary_search_by(|r| r.id.as_str().cmp(id))
            .ok()
            .map(|index| &self.relationships[index])
    }

    /// Every published item's datings grouped by aspect, in display order:
    /// each group sits where its earliest dating falls and keeps all its
    /// competing datings together. Nothing is chosen or merged.
    pub fn dated_aspects(&self) -> Vec<DatedAspect<'_>> {
        let mut groups: Vec<DatedAspect<'_>> = Vec::new();
        let mut at: BTreeMap<(&str, Aspect), usize> = BTreeMap::new();
        for dating in &self.datings {
            let key = (dating.owner.as_str(), dating.aspect);
            let index = *at.entry(key).or_insert_with(|| {
                groups.push(DatedAspect {
                    owner: &dating.owner,
                    owner_type: dating.owner_type,
                    aspect: dating.aspect,
                    datings: Vec::new(),
                    placed: false,
                    start_year: None,
                });
                groups.len() - 1
            });
            let group = &mut groups[index];
            if dating.placement == Placement::Dated && !group.placed {
                group.placed = true;
                group.start_year = dating.start_year;
            }
            group.datings.push(dating);
        }
        groups
    }

    /// One entry's or relationship's dated aspects, in display order.
    pub fn dated_aspects_of(&self, owner: &str) -> Vec<DatedAspect<'_>> {
        self.dated_aspects()
            .into_iter()
            .filter(|group| group.owner == owner)
            .collect()
    }

    /// The published relative datings of other items that point at an
    /// entry, in display order: the steps of a trail that lead to it. Each
    /// is someone's asserted order; none is derived from dates.
    pub fn relative_to(&self, entry: &str) -> Vec<&PublicDating> {
        self.datings
            .iter()
            .filter(|d| {
                d.owner != entry && d.date.relative.as_ref().is_some_and(|r| r.entry == entry)
            })
            .collect()
    }

    /// How an item reads in running text: an entry's label, or a
    /// relationship in its stored direction ("Plato member of The Academy").
    pub fn owner_text(&self, owner: &str, owner_type: OwnerType) -> String {
        let label = |id: &str| {
            self.entry(id)
                .map_or_else(|| id.to_string(), |entry| entry.label.clone())
        };
        match owner_type {
            OwnerType::Entry => label(owner),
            OwnerType::Relationship => match self.relationship(owner) {
                Some(r) => format!("{} {} {}", label(&r.from), r.label, label(&r.to)),
                None => owner.to_string(),
            },
        }
    }

    /// Where an item's datings are shown in full: an entry's dates section,
    /// or a relationship on the page of the entry it starts from.
    pub fn owner_url(&self, owner: &str, owner_type: OwnerType) -> String {
        match owner_type {
            OwnerType::Entry => format!("{}#atlas-section-dates", entry_url(owner)),
            OwnerType::Relationship => match self.relationship(owner) {
                Some(r) => format!("{}#atlas-r-{owner}", entry_url(&r.from)),
                None => ATLAS_URL.to_string(),
            },
        }
    }

    pub fn entry(&self, id: &str) -> Option<&PublicEntry> {
        self.entries
            .binary_search_by(|entry| entry.id.as_str().cmp(id))
            .ok()
            .map(|index| &self.entries[index])
    }

    pub fn source(&self, id: &str) -> Option<&PublicSource> {
        self.sources
            .binary_search_by(|source| source.reference.key.as_str().cmp(id))
            .ok()
            .map(|index| &self.sources[index])
    }

    /// Relationships starting at an entry, then those ending at it, each in id
    /// order. A relationship from an entry to itself is refused upstream.
    pub fn relationships_of(
        &self,
        id: &str,
    ) -> (Vec<&PublicRelationship>, Vec<&PublicRelationship>) {
        (
            self.relationships.iter().filter(|r| r.from == id).collect(),
            self.relationships.iter().filter(|r| r.to == id).collect(),
        )
    }

    /// The artifact as compact, deterministic JSON with root-relative URLs.
    /// `<`, `>` and `&` are written as escapes, so authored text can never
    /// close a `<script>` element the data is later embedded in.
    pub fn to_json(&self) -> String {
        escaped_json(self)
    }

    /// How a party reads on a page: the site author's name, a source's title,
    /// or the named party.
    pub fn party_text(&self, party: &PublicParty, author: &str) -> String {
        match party.kind {
            AttributionKind::Author => {
                let author = author.trim();
                if author.is_empty() {
                    "The site author".to_string()
                } else {
                    format!("{author} (the site author)")
                }
            }
            AttributionKind::Source => {
                let id = party.source.as_deref().unwrap_or_default();
                self.source(id)
                    .map(|source| source.text.clone())
                    .unwrap_or_else(|| id.to_string())
            }
            AttributionKind::Named => party.name.clone().unwrap_or_default(),
        }
    }

    /// One piece of evidence as readers see it: the reference, then where.
    pub fn evidence_text(&self, evidence: &PublicEvidence) -> String {
        let reference = self
            .source(&evidence.source)
            .map(|source| source.text.clone())
            .unwrap_or_else(|| evidence.source.clone());
        if evidence.locators.is_empty() {
            reference
        } else {
            format!(
                "{reference}, {}",
                CitationLocale::En.locators_text(&evidence.locators)
            )
        }
    }
}

/// An aspect as a heading.
pub fn aspect_heading(aspect: Aspect) -> &'static str {
    match aspect {
        Aspect::Span => "Span",
        Aspect::Birth => "Birth",
        Aspect::Death => "Death",
        Aspect::Active => "Activity (floruit)",
        Aspect::Composition => "Composition",
        Aspect::Publication => "Publication",
        Aspect::Emergence => "Emergence",
    }
}

/// An aspect as a noun in running text: "the composition of Phaedo".
pub fn aspect_noun(aspect: Aspect) -> &'static str {
    match aspect {
        Aspect::Span => "span",
        Aspect::Birth => "birth",
        Aspect::Death => "death",
        Aspect::Active => "activity",
        Aspect::Composition => "composition",
        Aspect::Publication => "publication",
        Aspect::Emergence => "emergence",
    }
}

/// The period a dated aspect is listed under on the timeline: the century
/// its earliest absolute dating begins in, with BCE written out ("5th
/// century BCE"), or the open-start group when that dating states no
/// earliest year.
pub fn period_label(start_year: Option<i32>) -> String {
    match start_year {
        None => "No earliest year stated (open start)".to_string(),
        Some(year) => {
            let (number, era) = century_of(year);
            format!("{} century {era}", ordinal(number))
        }
    }
}

/// A stable fragment id for a period: `atlas-period-bce-5`,
/// `atlas-period-ce-15`, or `atlas-period-open`.
pub fn period_id(start_year: Option<i32>) -> String {
    match start_year {
        None => "atlas-period-open".to_string(),
        Some(year) => {
            let (number, era) = century_of(year);
            format!("atlas-period-{}-{number}", era.to_ascii_lowercase())
        }
    }
}

/// A historical year's century by ordinal and era: 428 BCE is in the 5th
/// century BCE, 1 CE to 100 CE in the 1st century CE. There is no year 0.
fn century_of(year: i32) -> (u32, &'static str) {
    let era = if year < 0 { "BCE" } else { "CE" };
    (year.unsigned_abs().div_ceil(100).max(1), era)
}

fn ordinal(n: u32) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// The heading for a kind's group on the atlas index.
pub fn kind_heading(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::Person => "People",
        EntryKind::Work => "Works",
        EntryKind::Concept => "Concepts",
        EntryKind::Movement => "Movements",
        EntryKind::Event => "Events",
    }
}

/// The kind as a word in running text.
pub fn kind_label(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::Person => "Person",
        EntryKind::Work => "Work",
        EntryKind::Concept => "Concept",
        EntryKind::Movement => "Movement",
        EntryKind::Event => "Event",
    }
}

/// Confidence as a reader-facing word. It is how firmly the asserting party
/// holds the claim, never how widely it is accepted.
pub fn confidence_text(confidence: Confidence) -> &'static str {
    match confidence {
        Confidence::Tentative => "Tentative",
        Confidence::Plausible => "Plausible",
        Confidence::Strong => "Strong",
    }
}

/// Standing as a page words it: no recorded disagreement is never a claim of
/// agreement.
pub fn standing_text(standing: Standing, dissents: usize) -> String {
    match standing {
        Standing::Asserted => {
            "Asserted. No disagreement is recorded here; that is not a claim that it is agreed."
                .to_string()
        }
        Standing::Contested => format!(
            "Contested: {dissents} recorded dissent{}.",
            if dissents == 1 { "" } else { "s" }
        ),
    }
}

fn public_entry(entry: &Entry) -> PublicEntry {
    PublicEntry {
        id: entry.id.clone(),
        kind: entry.kind,
        label: entry.label.clone(),
        aliases: entry.aliases.clone(),
        summary: entry.summary.clone(),
        source: entry.source.clone(),
        url: entry_url(&entry.id),
    }
}

fn public_relationship(r: &Relationship) -> PublicRelationship {
    PublicRelationship {
        id: r.id.clone(),
        kind: r.kind,
        from: r.from.clone(),
        to: r.to.clone(),
        label: r.kind.label(),
        inverse_label: r.kind.inverse_label(),
        asserted_by: public_party(&r.asserted_by),
        confidence: r.confidence,
        evidence: public_evidence(&r.evidence),
        uncertainty: r.uncertainty.clone(),
        standing: r.standing(),
        contested_by: r.contested_by.iter().map(public_dissent).collect(),
    }
}

fn public_dating(
    owner: &str,
    owner_type: OwnerType,
    dating: &Dating,
    labels: &BTreeMap<&str, &str>,
) -> PublicDating {
    let (placement, start_year, end_year) = match dating.key() {
        ChronoKey::Dated { start, end } => (
            Placement::Dated,
            (start.0 != i32::MIN).then_some(start.0),
            (end.0 != i32::MAX).then_some(end.0),
        ),
        ChronoKey::Relative => (Placement::Relative, None, None),
        ChronoKey::Unknown => (Placement::Unknown, None, None),
    };
    let point = |p: &Option<Point>| p.as_ref().map(public_point);
    let mut date = PublicDate::default();
    let text = match &dating.date.form {
        DateForm::At(p) => {
            date.at = Some(public_point(p));
            date_text(&dating.date)
        }
        DateForm::Span { from, to } => {
            date.from = point(from);
            date.to = point(to);
            date_text(&dating.date)
        }
        DateForm::Window {
            not_before,
            not_after,
        } => {
            date.not_before = point(not_before);
            date.not_after = point(not_after);
            date_text(&dating.date)
        }
        DateForm::Unknown => {
            date.unknown = true;
            "unknown".to_string()
        }
        DateForm::Relative(relative) => {
            date.relative = Some(PublicRelative {
                order: relative.order,
                entry: relative.entry.clone(),
                aspect: relative.aspect,
            });
            let label = labels
                .get(relative.entry.as_str())
                .copied()
                .unwrap_or(relative.entry.as_str());
            format!(
                "{} the {} of {label}",
                relative.order.as_str(),
                aspect_noun(relative.aspect)
            )
        }
    };
    PublicDating {
        id: dating.id.clone(),
        owner: owner.to_string(),
        owner_type,
        aspect: dating.aspect,
        date,
        text,
        placement,
        start_year,
        end_year,
        asserted_by: public_party(&dating.asserted_by),
        confidence: dating.confidence,
        evidence: public_evidence(&dating.evidence),
        note: dating.note.clone(),
    }
}

fn public_point(point: &Point) -> PublicPoint {
    let mut public = PublicPoint {
        circa: point.circa,
        calendar: point.calendar,
        ..PublicPoint::default()
    };
    match point.stated {
        Stated::Year { year, month, day } => {
            public.year = Some(year);
            public.month = month;
            public.day = day;
        }
        Stated::Decade(decade) => public.decade = Some(decade),
        Stated::Century(century) => public.century = Some(century),
    }
    public
}

pub(crate) fn public_party(party: &Attribution) -> PublicParty {
    PublicParty {
        kind: party.kind,
        source: party.source.clone(),
        name: party.name.clone(),
    }
}

pub(crate) fn public_evidence(evidence: &[Evidence]) -> Vec<PublicEvidence> {
    evidence
        .iter()
        .map(|item| PublicEvidence {
            source: item.source.clone(),
            locators: item.locators.iter().map(PublicLocator::from).collect(),
        })
        .collect()
}

fn public_dissent(dissent: &Dissent) -> PublicDissent {
    PublicDissent {
        by: public_party(&dissent.by),
        evidence: public_evidence(&dissent.evidence),
        note: dissent.note.clone(),
    }
}

fn relationship_sources(r: &PublicRelationship) -> impl Iterator<Item = &str> {
    let parties = std::iter::once(&r.asserted_by)
        .chain(r.contested_by.iter().map(|d| &d.by))
        .filter_map(|party| party.source.as_deref());
    r.evidence
        .iter()
        .chain(r.contested_by.iter().flat_map(|d| d.evidence.iter()))
        .map(|e| e.source.as_str())
        .chain(parties)
}
