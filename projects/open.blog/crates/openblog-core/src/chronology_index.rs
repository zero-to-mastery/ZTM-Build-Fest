//! Deterministic chronology indexes and structural prompts over a valid
//! Knowledge Atlas (ADR 0096, ADR 0097).
//!
//! The index places every dating by the entry or relationship it dates, by
//! aspect and in time. Competing datings stay side by side and none is
//! dropped, preferred or merged; circa, relative and unknown datings are all
//! kept. Order comes from [`DateExpr::key`](crate::chronology::DateExpr::key)
//! and dating ids alone, so the same atlas always gives the same index however
//! its file lists things.
//!
//! The prompts are the only judgement here, and they are structural: each
//! names authored datings that, as recorded, cannot all hold (a death that
//! ends before the birth can begin, relative datings that order two aspects
//! both ways round). They are prompts to check, never verdicts: they never say
//! which dating is right, never change or hide one, and never make the atlas
//! invalid. Nothing here creates a dating, an order or a relationship, and
//! datings that are close in time are never linked: only what someone
//! recorded is compared.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;

use serde::Serialize;

use crate::chronology::{
    chronological, Aspect, ChronoKey, DateExpr, DateForm, Dating, Point, Stated, TemporalOrder,
};
use crate::knowledge_atlas::{Atlas, EntryKind, RelationshipKind};

/// The most prompts an index lists; any more are counted in
/// [`ChronologyIndex::unlisted`].
pub const MAX_CHRONOLOGY_PROMPTS: usize = 1_000;
/// The most dating ids one prompt's message names before it counts the rest.
const NAMED_IN_MESSAGE: usize = 10;

/// What a structural prompt is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChronologyPromptCode {
    /// A person's death dating ends before one of their birth datings can begin.
    DeathBeforeBirth,
    /// A work's composition begins after the life of a person recorded as its
    /// author has ended.
    CompositionAfterDeath,
    /// A work's composition ends before the life of a person recorded as its
    /// author can begin.
    CompositionBeforeBirth,
    /// A work's publication ends before its composition can begin.
    PublicationBeforeComposition,
    /// A person's activity, or a relationship that needs them alive, is dated
    /// wholly outside their life.
    OutsideLifetime,
    /// Two relative datings order the same two aspects in ways that cannot
    /// both hold.
    OpposedRelative,
    /// Relative datings order three or more aspects in a loop.
    RelativeCycle,
    /// A relative dating disagrees with absolute datings of the two aspects
    /// it orders.
    RelativeAgainstDates,
}

impl fmt::Display for ChronologyPromptCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = serde_json::to_value(self)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        formatter.write_str(&text)
    }
}

/// A structural prompt to check some datings, scoped to the entry or
/// relationship that owns the dating it starts from. It names ids and the
/// stated date values only, never labels, notes, party names or other
/// authored text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronologyPrompt {
    pub code: ChronologyPromptCode,
    /// `entries` or `relationships`.
    pub collection: &'static str,
    pub index: usize,
    /// The entry or relationship the prompt is scoped to.
    pub id: String,
    /// The dating the prompt starts from, as a field of that item: `dates[1]`.
    pub field: String,
    /// Every dating the prompt is about, the scoped one first.
    pub datings: Vec<String>,
    pub message: String,
    /// Each of those datings' id, aspect and stated date, in the same
    /// order: what the prompt says, without positions or sentences, for an
    /// author's acknowledgement (ADR 0147). Never serialized.
    #[serde(skip)]
    pub facts: Vec<String>,
}

impl fmt::Display for ChronologyPrompt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}[{}] `{}` {}: {} ({})",
            self.collection, self.index, self.id, self.field, self.message, self.code
        )
    }
}

/// Where the index places one dating.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placed {
    /// The entry or relationship the dating dates.
    pub owner: String,
    pub aspect: Aspect,
    pub key: ChronoKey,
}

/// Lookup tables over every dating of one atlas, private or approved. Every
/// list is in chronological order (earliest then latest stated day, then
/// relative datings, then unknown ones, ties broken by dating id), and every
/// dating appears in each table it belongs to exactly once.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChronologyIndex {
    /// Every dating by id.
    pub datings: BTreeMap<String, Placed>,
    /// Each entry's or relationship's datings by aspect. A group with more
    /// than one dating holds competing datings, side by side.
    pub by_owner: BTreeMap<String, BTreeMap<Aspect, Vec<String>>>,
    /// The datings of each aspect across the atlas.
    pub by_aspect: BTreeMap<Aspect, Vec<String>>,
    /// Every dating in time order: one timeline with nothing collapsed.
    pub by_time: Vec<String>,
    /// The relative datings that point at each entry.
    pub relative_to: BTreeMap<String, Vec<String>>,
    /// Structural prompts, sorted by the item they are scoped to (then by
    /// datings, code and message, so the order is total), at most
    /// [`MAX_CHRONOLOGY_PROMPTS`].
    pub prompts: Vec<ChronologyPrompt>,
    /// Prompts found beyond the limit and not listed.
    pub unlisted: usize,
}

/// One owner of datings, as the prompts need it.
struct Owner<'a> {
    collection: &'static str,
    index: usize,
    kind: Option<EntryKind>,
    dates: &'a [Dating],
}

/// One dated aspect of one entry or relationship: a node of relative order.
type Node<'a> = (&'a str, Aspect);

struct Builder<'a> {
    owners: HashMap<&'a str, Owner<'a>>,
    prompts: Vec<ChronologyPrompt>,
}

impl ChronologyIndex {
    /// Index a validated atlas. It reads the atlas only and never fails.
    pub fn of(atlas: &Atlas) -> Self {
        let mut index = Self::default();
        let mut sorted = atlas.all_datings();
        sorted.sort_by(|a, b| chronological(a.1, b.1));
        for (owner, dating) in &sorted {
            index.datings.insert(
                dating.id.clone(),
                Placed {
                    owner: owner.to_string(),
                    aspect: dating.aspect,
                    key: dating.key(),
                },
            );
            index
                .by_owner
                .entry(owner.to_string())
                .or_default()
                .entry(dating.aspect)
                .or_default()
                .push(dating.id.clone());
            index
                .by_aspect
                .entry(dating.aspect)
                .or_default()
                .push(dating.id.clone());
            index.by_time.push(dating.id.clone());
            if let Some(target) = dating.relative_target() {
                index
                    .relative_to
                    .entry(target.entry.clone())
                    .or_default()
                    .push(dating.id.clone());
            }
        }
        let mut builder = Builder::new(atlas);
        builder.lifetimes();
        builder.works(atlas);
        builder.relationships_needing_life(atlas);
        builder.relative(&sorted);
        let mut prompts = builder.prompts;
        // The message breaks the last ties: two relationships recording the
        // same author give prompts with the same item, datings and code that
        // differ only in the relationship they name, and their order must not
        // follow the file.
        prompts.sort_by(|a, b| {
            (&a.id, &a.datings, a.code, &a.message).cmp(&(&b.id, &b.datings, b.code, &b.message))
        });
        prompts.dedup();
        index.unlisted = prompts.len().saturating_sub(MAX_CHRONOLOGY_PROMPTS);
        prompts.truncate(MAX_CHRONOLOGY_PROMPTS);
        index.prompts = prompts;
        index
    }

    /// The datings of one aspect of one entry or relationship: its competing
    /// datings, side by side in time order.
    pub fn competing(&self, owner: &str, aspect: Aspect) -> &[String] {
        self.by_owner
            .get(owner)
            .and_then(|aspects| aspects.get(&aspect))
            .map_or(&[], Vec::as_slice)
    }
}

/// The earliest and latest points an absolute dating allows, either open.
/// A relative or unknown dating has no extent.
fn extent(dating: &Dating) -> Option<(Option<&Point>, Option<&Point>)> {
    match &dating.date.form {
        DateForm::At(point) => Some((Some(point), Some(point))),
        DateForm::Span { from, to } => Some((from.as_ref(), to.as_ref())),
        DateForm::Window {
            not_before,
            not_after,
        } => Some((not_before.as_ref(), not_after.as_ref())),
        DateForm::Unknown | DateForm::Relative(_) => None,
    }
}

/// Whether everything `earlier` allows ends before anything `later` allows
/// can begin, as stated: the latest day of `earlier`'s end against the
/// earliest day of `later`'s start. Months and days count only when both
/// points state the same calendar (or neither does), otherwise only years,
/// because nothing converts calendars. An open end never ends before
/// anything, and circa never moves a point.
fn wholly_before(earlier: &Dating, later: &Dating) -> bool {
    let (Some((_, Some(end))), Some((Some(start), _))) = (extent(earlier), extent(later)) else {
        return false;
    };
    if end.calendar == start.calendar {
        end.last() < start.first()
    } else {
        end.years().1 < start.years().0
    }
}

fn same_party(a: &Dating, b: &Dating) -> bool {
    let party = |d: &Dating| {
        (
            d.asserted_by.kind,
            d.asserted_by.source.clone(),
            d.asserted_by.name.clone(),
        )
    };
    party(a) == party(b)
}

/// How a prompt ends: a request to check, never a ruling. Datings from
/// different parties may well be a recorded disagreement that stays.
fn closing(datings: &[&Dating]) -> &'static str {
    let same = datings.windows(2).all(|pair| same_party(pair[0], pair[1]));
    if same {
        "They come from the same party: check the values against the cited evidence."
    } else {
        "They come from different parties: check the values against the cited evidence; a recorded disagreement can stay side by side as it is."
    }
}

fn year_text(year: i32) -> String {
    if year < 0 {
        format!("{} BCE", year.unsigned_abs())
    } else {
        format!("{year} CE")
    }
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

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// A point as stated, at its own precision: "c. 428 BCE", "the 380s BCE",
/// "4th century BCE", "15 Mar 44 BCE (julian)". Never rounded or converted.
pub fn point_text(point: &Point) -> String {
    let mut text = String::new();
    if point.circa {
        text.push_str("c. ");
    }
    match point.stated {
        Stated::Year { year, month, day } => {
            if let Some(day) = day {
                text.push_str(&format!("{day} "));
            }
            if let Some(month) = month {
                let name = MONTHS.get(usize::from(month).saturating_sub(1));
                text.push_str(&format!("{} ", name.copied().unwrap_or("?")));
            }
            text.push_str(&year_text(year));
        }
        Stated::Decade(decade) => {
            let era = if decade < 0 { "BCE" } else { "CE" };
            let the = if point.circa { "" } else { "the " };
            text.push_str(&format!("{the}{}s {era}", decade.unsigned_abs()));
        }
        Stated::Century(century) => {
            let era = if century < 0 { "BCE" } else { "CE" };
            text.push_str(&format!(
                "{} century {era}",
                ordinal(century.unsigned_abs())
            ));
        }
    }
    if let Some(calendar) = point.calendar {
        let name = serde_json::to_value(calendar)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        text.push_str(&format!(" ({name})"));
    }
    text
}

/// A date expression as stated: a point, "from A to B", "between A and B",
/// "not before A", "unknown", or "after `phaedo` composition".
pub fn date_text(date: &DateExpr) -> String {
    let ends =
        |a: &Option<Point>, b: &Option<Point>, both: &str, and: &str, first: &str, last: &str| {
            match (a, b) {
                (Some(a), Some(b)) => format!("{both}{} {and} {}", point_text(a), point_text(b)),
                (Some(a), None) => format!("{first} {}", point_text(a)),
                (None, Some(b)) => format!("{last} {}", point_text(b)),
                (None, None) => "open".into(),
            }
        };
    match &date.form {
        DateForm::At(point) => point_text(point),
        DateForm::Span { from, to } => ends(from, to, "from ", "to", "from", "until"),
        DateForm::Window {
            not_before,
            not_after,
        } => ends(
            not_before,
            not_after,
            "between ",
            "and",
            "not before",
            "not after",
        ),
        DateForm::Unknown => "unknown".into(),
        DateForm::Relative(relative) => format!(
            "{} `{}` {}",
            relative.order.as_str(),
            relative.entry,
            relative.aspect.as_str()
        ),
    }
}

/// "death dating `d` (c. 348 BCE)", optionally naming whose.
fn named(owner: Option<&str>, dating: &Dating) -> String {
    let whose = owner.map(|o| format!("`{o}`'s ")).unwrap_or_default();
    format!(
        "{whose}{} dating `{}` ({})",
        dating.aspect.as_str(),
        dating.id,
        date_text(&dating.date)
    )
}

/// "`plato` composition": a dated aspect of an item.
fn node_text(node: Node<'_>) -> String {
    format!("`{}` {}", node.0, node.1.as_str())
}

/// The ids of a list, named up to a limit, then counted.
fn id_list(ids: &[&str]) -> String {
    let mut named: Vec<String> = ids
        .iter()
        .take(NAMED_IN_MESSAGE)
        .map(|id| format!("`{id}`"))
        .collect();
    if ids.len() > NAMED_IN_MESSAGE {
        named.push(format!("{} more", ids.len() - NAMED_IN_MESSAGE));
    }
    match named.len() {
        0 => String::new(),
        1 => named.remove(0),
        _ => {
            let last = named.pop().unwrap_or_default();
            format!("{} and {last}", named.join(", "))
        }
    }
}

impl<'a> Builder<'a> {
    fn new(atlas: &'a Atlas) -> Self {
        let mut owners = HashMap::new();
        for (index, entry) in atlas.entries.iter().enumerate() {
            owners.insert(
                entry.id.as_str(),
                Owner {
                    collection: "entries",
                    index,
                    kind: Some(entry.kind),
                    dates: &entry.dates,
                },
            );
        }
        for (index, relationship) in atlas.relationships.iter().enumerate() {
            owners.insert(
                relationship.id.as_str(),
                Owner {
                    collection: "relationships",
                    index,
                    kind: None,
                    dates: &relationship.dates,
                },
            );
        }
        Self {
            owners,
            prompts: Vec::new(),
        }
    }

    fn of(&self, owner: &str, aspects: &[Aspect]) -> Vec<&'a Dating> {
        self.owners.get(owner).map_or_else(Vec::new, |o| {
            o.dates
                .iter()
                .filter(|d| aspects.contains(&d.aspect))
                .collect()
        })
    }

    fn is_person(&self, id: &str) -> bool {
        self.owners
            .get(id)
            .is_some_and(|o| o.kind == Some(EntryKind::Person))
    }

    /// Record a prompt scoped to the owner of `subject`, which comes first in
    /// `datings`.
    fn prompt(
        &mut self,
        code: ChronologyPromptCode,
        owner: &str,
        subject: &Dating,
        others: &[&Dating],
        message: String,
    ) {
        let Some(item) = self.owners.get(owner) else {
            return;
        };
        let position = item
            .dates
            .iter()
            .position(|d| d.id == subject.id)
            .unwrap_or_default();
        let stated = |d: &Dating| {
            format!(
                "{} {} {}",
                d.id,
                d.aspect.as_str(),
                serde_json::to_string(&d.date).unwrap_or_default()
            )
        };
        let mut datings = vec![subject.id.clone()];
        let mut facts = vec![stated(subject)];
        for other in others {
            if !datings.contains(&other.id) {
                datings.push(other.id.clone());
                facts.push(stated(other));
            }
        }
        self.prompts.push(ChronologyPrompt {
            code,
            collection: item.collection,
            index: item.index,
            id: owner.to_string(),
            field: format!("dates[{position}]"),
            datings,
            message,
            facts,
        });
    }

    /// Within one person: death against birth, and activity against life.
    /// A person's `span` is their lifetime, so it bounds activity too.
    fn lifetimes(&mut self) {
        let mut people: Vec<&'a str> = self
            .owners
            .iter()
            .filter(|(_, o)| o.kind == Some(EntryKind::Person))
            .map(|(id, _)| *id)
            .collect();
        people.sort_unstable();
        for person in people {
            let births = self.of(person, &[Aspect::Birth]);
            for death in self.of(person, &[Aspect::Death]) {
                for birth in births.iter().filter(|b| wholly_before(death, b)) {
                    let message = format!(
                        "{} ends before {} can begin, so as recorded they cannot both hold. {}",
                        named(None, death),
                        named(None, birth),
                        closing(&[death, birth])
                    );
                    self.prompt(
                        ChronologyPromptCode::DeathBeforeBirth,
                        person,
                        death,
                        &[birth],
                        message,
                    );
                }
            }
            let starts = self.of(person, &[Aspect::Birth, Aspect::Span]);
            let ends = self.of(person, &[Aspect::Death, Aspect::Span]);
            for active in self.of(person, &[Aspect::Active]) {
                self.outside_life(person, None, active, &starts, &ends, "");
            }
        }
    }

    /// Prompt when `subject` (owned by `owner`) lies wholly outside the life
    /// of `person`, judged against the life's start and end datings.
    fn outside_life(
        &mut self,
        owner: &str,
        person: Option<&str>,
        subject: &'a Dating,
        starts: &[&'a Dating],
        ends: &[&'a Dating],
        context: &str,
    ) {
        for start in starts.iter().filter(|s| wholly_before(subject, s)) {
            let message = format!(
                "{} ends before {} can begin{context}, so as recorded they cannot all hold. {}",
                named(None, subject),
                named(person, start),
                closing(&[subject, start])
            );
            self.prompt(
                ChronologyPromptCode::OutsideLifetime,
                owner,
                subject,
                &[start],
                message,
            );
        }
        for end in ends.iter().filter(|e| wholly_before(e, subject)) {
            let message = format!(
                "{} begins after {} ends{context}, so as recorded they cannot all hold. {}",
                named(None, subject),
                named(person, end),
                closing(&[subject, end])
            );
            self.prompt(
                ChronologyPromptCode::OutsideLifetime,
                owner,
                subject,
                &[end],
                message,
            );
        }
    }

    /// Within one work, publication against composition; and across an
    /// `authored` relationship, composition against its author's life.
    fn works(&mut self, atlas: &'a Atlas) {
        let mut works: Vec<&'a str> = self
            .owners
            .iter()
            .filter(|(_, o)| o.kind == Some(EntryKind::Work))
            .map(|(id, _)| *id)
            .collect();
        works.sort_unstable();
        for work in works {
            let compositions = self.of(work, &[Aspect::Composition]);
            for publication in self.of(work, &[Aspect::Publication]) {
                for composition in compositions
                    .iter()
                    .filter(|c| wholly_before(publication, c))
                {
                    let message = format!(
                        "{} ends before {} can begin, so as recorded they cannot both hold. {}",
                        named(None, publication),
                        named(None, composition),
                        closing(&[publication, composition])
                    );
                    self.prompt(
                        ChronologyPromptCode::PublicationBeforeComposition,
                        work,
                        publication,
                        &[composition],
                        message,
                    );
                }
            }
        }
        for relationship in &atlas.relationships {
            if relationship.kind != RelationshipKind::Authored
                || !self.is_person(&relationship.from)
            {
                continue;
            }
            let (person, work) = (relationship.from.as_str(), relationship.to.as_str());
            let starts = self.of(person, &[Aspect::Birth, Aspect::Span]);
            let ends = self.of(person, &[Aspect::Death, Aspect::Span]);
            let context = format!(
                ", while relationship `{}` records `{person}` as its author",
                relationship.id
            );
            for composition in self.of(work, &[Aspect::Composition]) {
                for end in ends.iter().filter(|e| wholly_before(e, composition)) {
                    let message = format!(
                        "{} begins after {} ends{context}, so as recorded they cannot all hold. {}",
                        named(None, composition),
                        named(Some(person), end),
                        closing(&[composition, end])
                    );
                    self.prompt(
                        ChronologyPromptCode::CompositionAfterDeath,
                        work,
                        composition,
                        &[end],
                        message,
                    );
                }
                for start in starts.iter().filter(|s| wholly_before(composition, s)) {
                    let message = format!(
                        "{} ends before {} can begin{context}, so as recorded they cannot all hold. {}",
                        named(None, composition),
                        named(Some(person), start),
                        closing(&[composition, start])
                    );
                    self.prompt(
                        ChronologyPromptCode::CompositionBeforeBirth,
                        work,
                        composition,
                        &[start],
                        message,
                    );
                }
            }
        }
    }

    /// A relationship whose person must be alive while it holds (authoring,
    /// membership, participation, developing a concept), dated wholly outside
    /// that person's life. Influence and response can outlive a person, so
    /// they are never checked.
    fn relationships_needing_life(&mut self, atlas: &'a Atlas) {
        for relationship in &atlas.relationships {
            let needs_life = matches!(
                relationship.kind,
                RelationshipKind::Authored
                    | RelationshipKind::MemberOf
                    | RelationshipKind::ParticipatedIn
                    | RelationshipKind::Developed
            );
            if !needs_life || !self.is_person(&relationship.from) || relationship.dates.is_empty() {
                continue;
            }
            let person = relationship.from.as_str();
            let starts = self.of(person, &[Aspect::Birth, Aspect::Span]);
            let ends = self.of(person, &[Aspect::Death, Aspect::Span]);
            let context = format!(
                ", while this `{}` relationship needs `{person}` alive",
                relationship.kind.as_str()
            );
            for span in &relationship.dates {
                self.outside_life(
                    &relationship.id,
                    Some(person),
                    span,
                    &starts,
                    &ends,
                    &context,
                );
            }
        }
    }

    /// Relative datings: opposed pairs, loops, and disagreement with the
    /// absolute datings of the aspects they order. Only recorded relative
    /// datings are edges; nothing else orders two aspects.
    fn relative(&mut self, sorted: &[(&'a str, &'a Dating)]) {
        // Each relative dating as (earlier, later) for before/after, or
        // (inner, outer) for during, with the dating and its owner.
        struct Rel<'a> {
            owner: &'a str,
            dating: &'a Dating,
            a: Node<'a>,
            b: Node<'a>,
            during: bool,
        }
        let mut rels: Vec<Rel<'a>> = Vec::new();
        for (owner, dating) in sorted {
            let Some(target) = dating.relative_target() else {
                continue;
            };
            let own: Node<'a> = (owner, dating.aspect);
            let other: Node<'a> = (target.entry.as_str(), target.aspect);
            let (a, b, during) = match target.order {
                TemporalOrder::Before => (own, other, false),
                TemporalOrder::After => (other, own, false),
                TemporalOrder::During => (own, other, true),
            };
            rels.push(Rel {
                owner,
                dating,
                a,
                b,
                during,
            });
        }
        rels.sort_by(|x, y| x.dating.id.cmp(&y.dating.id));
        let sentence = |rel: &Rel<'_>| {
            format!(
                "relative dating `{}` ({} {})",
                rel.dating.id,
                node_text((rel.owner, rel.dating.aspect)),
                date_text(&rel.dating.date)
            )
        };

        // Opposed pairs: the same two aspects, ordered both ways round, or
        // one inside the other while also wholly before or after it.
        let mut by_pair: BTreeMap<(Node<'a>, Node<'a>), Vec<usize>> = BTreeMap::new();
        for (position, rel) in rels.iter().enumerate() {
            let pair = if rel.a <= rel.b {
                (rel.a, rel.b)
            } else {
                (rel.b, rel.a)
            };
            by_pair.entry(pair).or_default().push(position);
        }
        for positions in by_pair.values() {
            for (i, &first) in positions.iter().enumerate() {
                for &second in &positions[i + 1..] {
                    let (x, y) = (&rels[first], &rels[second]);
                    let opposed = match (x.during, y.during) {
                        (false, false) => x.a == y.b && x.b == y.a,
                        (true, true) => false,
                        _ => true,
                    };
                    if !opposed {
                        continue;
                    }
                    let message = format!(
                        "{} and {} order the same two aspects in ways that cannot both hold as recorded. {}",
                        sentence(x),
                        sentence(y),
                        closing(&[x.dating, y.dating])
                    );
                    self.prompt(
                        ChronologyPromptCode::OpposedRelative,
                        x.owner,
                        x.dating,
                        &[y.dating],
                        message,
                    );
                }
            }
        }

        // Loops of three or more aspects among strict before/after orders.
        let strict: Vec<&Rel<'a>> = rels.iter().filter(|r| !r.during).collect();
        let mut graph: BTreeMap<Node<'a>, BTreeSet<Node<'a>>> = BTreeMap::new();
        for rel in &strict {
            graph.entry(rel.a).or_default().insert(rel.b);
            graph.entry(rel.b).or_default();
        }
        for component in strongly_connected(&graph) {
            if component.len() < 3 {
                continue;
            }
            let inside: Vec<&Rel<'a>> = strict
                .iter()
                .copied()
                .filter(|r| component.contains(&r.a) && component.contains(&r.b))
                .collect();
            let Some(first) = inside.first() else {
                continue;
            };
            let ids: Vec<&str> = inside.iter().map(|r| r.dating.id.as_str()).collect();
            let nodes: Vec<String> = component.iter().map(|n| node_text(*n)).collect();
            let datings: Vec<&Dating> = inside.iter().map(|r| r.dating).collect();
            let shown: Vec<&str> = nodes.iter().map(String::as_str).collect();
            let message = format!(
                "relative datings {} order {} in a loop, so each would have to come before itself; as recorded they cannot all hold. {}",
                id_list(&ids),
                plain_list(&shown),
                closing(&datings)
            );
            self.prompt(
                ChronologyPromptCode::RelativeCycle,
                first.owner,
                first.dating,
                &datings[1..],
                message,
            );
        }

        // Disagreement with absolute datings of the two aspects.
        for rel in &rels {
            let side = |node: Node<'a>| -> Vec<&'a Dating> {
                let mut found: Vec<&'a Dating> = self
                    .of(node.0, &[node.1])
                    .into_iter()
                    .filter(|d| extent(d).is_some())
                    .collect();
                found.sort_by(|x, y| chronological(x, y));
                found
            };
            let (left, right) = (side(rel.a), side(rel.b));
            let mut pairs: Vec<(&Dating, &Dating, &'static str)> = Vec::new();
            for l in &left {
                for r in &right {
                    if wholly_before(r, l) {
                        // The relative dating puts `a` first (or inside `b`),
                        // yet `b` is dated wholly before `a`.
                        pairs.push((l, r, "begins after"));
                    } else if rel.during && wholly_before(l, r) {
                        pairs.push((l, r, "ends before"));
                    }
                }
            }
            let Some((l, r, relation)) = pairs.first().copied() else {
                continue;
            };
            let rest = pairs.len() - 1;
            let more = if rest == 0 {
                String::new()
            } else {
                format!(
                    ", and {rest} other pair{} of absolute datings disagree the same way",
                    if rest == 1 { "" } else { "s" }
                )
            };
            let ends = if relation == "begins after" {
                "ends"
            } else {
                "can begin"
            };
            let mut involved: Vec<&Dating> = vec![rel.dating];
            for (l, r, _) in &pairs {
                involved.push(l);
                involved.push(r);
            }
            let message = format!(
                "{} disagrees with absolute datings: {} {relation} {} {ends}{more}, so as recorded they cannot all hold. {}",
                sentence(rel),
                named(Some(rel.a.0), l),
                named(Some(rel.b.0), r),
                closing(&involved)
            );
            self.prompt(
                ChronologyPromptCode::RelativeAgainstDates,
                rel.owner,
                rel.dating,
                &involved[1..],
                message,
            );
        }
    }
}

/// "a, b and c".
fn plain_list(items: &[&str]) -> String {
    let mut named: Vec<String> = items
        .iter()
        .take(NAMED_IN_MESSAGE)
        .map(|s| s.to_string())
        .collect();
    if items.len() > NAMED_IN_MESSAGE {
        named.push(format!("{} more", items.len() - NAMED_IN_MESSAGE));
    }
    match named.len() {
        0 => String::new(),
        1 => named.remove(0),
        _ => {
            let last = named.pop().unwrap_or_default();
            format!("{} and {last}", named.join(", "))
        }
    }
}

/// The strongly connected components of a graph, each sorted, in sorted
/// order. Iterative (Kosaraju), so a long chain cannot exhaust the stack.
fn strongly_connected<N: Copy + Ord>(graph: &BTreeMap<N, BTreeSet<N>>) -> Vec<Vec<N>> {
    let mut reverse: BTreeMap<N, Vec<N>> = BTreeMap::new();
    for (from, tos) in graph {
        reverse.entry(*from).or_default();
        for to in tos {
            reverse.entry(*to).or_default().push(*from);
        }
    }
    // First pass: finishing order.
    let mut seen: BTreeSet<N> = BTreeSet::new();
    let mut order: Vec<N> = Vec::new();
    for start in graph.keys() {
        if !seen.insert(*start) {
            continue;
        }
        let mut stack: Vec<(N, Vec<N>)> = vec![(
            *start,
            graph.get(start).into_iter().flatten().copied().collect(),
        )];
        while let Some((node, pending)) = stack.last_mut() {
            if let Some(next) = pending.pop() {
                if seen.insert(next) {
                    let children = graph.get(&next).into_iter().flatten().copied().collect();
                    stack.push((next, children));
                }
            } else {
                order.push(*node);
                stack.pop();
            }
        }
    }
    // Second pass: components on the reversed graph.
    let mut assigned: BTreeSet<N> = BTreeSet::new();
    let mut components = Vec::new();
    for start in order.iter().rev() {
        if !assigned.insert(*start) {
            continue;
        }
        let mut component = vec![*start];
        let mut stack = vec![*start];
        while let Some(node) = stack.pop() {
            for next in reverse.get(&node).into_iter().flatten() {
                if assigned.insert(*next) {
                    component.push(*next);
                    stack.push(*next);
                }
            }
        }
        component.sort();
        components.push(component);
    }
    components.sort();
    components
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_find_loops_and_leave_chains_apart() {
        let mut graph: BTreeMap<u8, BTreeSet<u8>> = BTreeMap::new();
        for (a, b) in [(1, 2), (2, 3), (3, 1), (3, 4), (4, 5), (6, 6)] {
            graph.entry(a).or_default().insert(b);
            graph.entry(b).or_default();
        }
        assert_eq!(
            strongly_connected(&graph),
            vec![vec![1, 2, 3], vec![4], vec![5], vec![6]]
        );
        // A long chain is not a loop and does not exhaust the stack.
        let mut chain: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
        for n in 0..100_000u32 {
            chain.entry(n).or_default().insert(n + 1);
        }
        chain.entry(100_000).or_default();
        assert!(strongly_connected(&chain).iter().all(|c| c.len() == 1));
    }

    #[test]
    fn points_read_back_at_their_own_precision() {
        let stated = |stated: Stated, circa: bool| {
            point_text(&Point {
                stated,
                circa,
                ..Point::year(1)
            })
        };
        assert_eq!(stated(Stated::Decade(-380), false), "the 380s BCE");
        assert_eq!(stated(Stated::Decade(1380), true), "c. 1380s CE");
        assert_eq!(stated(Stated::Century(-4), false), "4th century BCE");
        assert_eq!(stated(Stated::Century(21), false), "21st century CE");
        assert_eq!(stated(Stated::Century(12), false), "12th century CE");
        let circa = Point {
            circa: true,
            ..Point::year(-428)
        };
        assert_eq!(point_text(&circa), "c. 428 BCE");
        assert_eq!(point_text(&Point::year(1380)), "1380 CE");
        let mut ides = Point::year(-44);
        ides.stated = Stated::Year {
            year: -44,
            month: Some(3),
            day: Some(15),
        };
        ides.calendar = Some(crate::chronology::Calendar::Julian);
        assert_eq!(point_text(&ides), "15 Mar 44 BCE (julian)");
    }
}
