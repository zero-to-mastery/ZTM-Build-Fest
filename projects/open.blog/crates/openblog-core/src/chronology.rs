//! Uncertain chronology for the Knowledge Atlas: attributed, cited datings of
//! entries and relationships, each at the precision its party states.
//!
//! A *dating* is one party's claim about when one aspect of an entry (a
//! person's birth, a work's composition) or a relationship happened. It is
//! never a fact: it names who dates it, on what evidence, how firmly, and
//! with what doubt. Several datings of the same aspect stand side by side and
//! nothing here picks one, averages them, converts calendars, or derives a
//! date, an order or a relationship from another date. A *relative dating*
//! ("composed after the Phaedo") is the only temporal relationship, and it
//! exists only because someone asserted it.
//!
//! Years use historical numbering: negative is BCE, and there is no year 0,
//! so 1 BCE (`-1`) is directly followed by 1 CE (`1`).

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::Value;

use crate::knowledge_atlas::{
    parse_attribution, parse_evidence_list, AtlasDiagnosticCode, Attribution, Confidence, Ctx,
    EntryKind, Evidence, Obj, Visibility, MAX_UNCERTAINTY_CHARS,
};

/// Upper bound on the datings one entry or relationship may carry.
pub const MAX_DATINGS: usize = 20;
/// The largest year magnitude a dating may state, either side of the era.
pub const MAX_YEAR: i32 = 100_000;
const MAX_CENTURY: i32 = MAX_YEAR / 100;

/// What a dating dates. Each aspect names the owners it applies to, so a work
/// has no birth and a person has no composition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Aspect {
    /// The whole period something existed, lasted or held: a lifetime, an
    /// event's duration, the time a relationship held. The only aspect of a
    /// relationship.
    Span,
    Birth,
    Death,
    /// A period of activity (floruit).
    Active,
    Composition,
    Publication,
    /// When a concept or movement first appears.
    Emergence,
}

impl Aspect {
    pub const ALL: [Self; 7] = [
        Self::Span,
        Self::Birth,
        Self::Death,
        Self::Active,
        Self::Composition,
        Self::Publication,
        Self::Emergence,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Span => "span",
            Self::Birth => "birth",
            Self::Death => "death",
            Self::Active => "active",
            Self::Composition => "composition",
            Self::Publication => "publication",
            Self::Emergence => "emergence",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|aspect| aspect.as_str() == value)
    }

    /// Whether the aspect lasts, so it may be dated as a span with `from` and
    /// `to`. A birth or a publication happens at one time, however uncertain;
    /// its uncertainty is a window (`notBefore`/`notAfter`), not a duration.
    pub fn is_durative(self) -> bool {
        matches!(self, Self::Span | Self::Active | Self::Composition)
    }

    /// Whether an entry of this kind can have the aspect.
    pub fn applies_to(self, kind: EntryKind) -> bool {
        match self {
            Self::Span => true,
            Self::Birth | Self::Death => kind == EntryKind::Person,
            Self::Active => matches!(kind, EntryKind::Person | EntryKind::Movement),
            Self::Composition | Self::Publication => kind == EntryKind::Work,
            Self::Emergence => matches!(kind, EntryKind::Concept | EntryKind::Movement),
        }
    }

    /// The aspects an entry of this kind can have, in a fixed order.
    pub fn of_entry(kind: EntryKind) -> Vec<Self> {
        Self::ALL
            .into_iter()
            .filter(|aspect| aspect.applies_to(kind))
            .collect()
    }
}

/// The calendar a month and day are stated in. Nothing converts between
/// them: a date is kept as its party gives it, and when two points state
/// different calendars only their years are compared.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Calendar {
    Gregorian,
    Julian,
}

/// How finely a point is stated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Precision {
    Day,
    Month,
    Year,
    Decade,
    Century,
}

/// What a point states, at exactly one precision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stated {
    /// A year, optionally with a month, and a day only with a month.
    Year {
        year: i32,
        month: Option<u8>,
        day: Option<u8>,
    },
    /// A decade named by its first year in CE (`1380` is 1380 to 1389) and by
    /// its last year in BCE (`-380` is 389 to 380 BCE), as decades are named.
    Decade(i32),
    /// A century by ordinal: `4` is 301 to 400, `-4` is 400 to 301 BCE.
    Century(i32),
}

/// A day as a sortable key: year, month and day. Years have no 0.
pub type DayKey = (i32, u8, u8);

/// One point in time at its stated precision, optionally approximate.
#[derive(Clone, Debug, PartialEq)]
pub struct Point {
    pub stated: Stated,
    /// The party gives the point as approximate ("c. 428 BCE").
    pub circa: bool,
    /// Only with a month: the calendar the month and day are stated in.
    /// Absent means as the cited party gives it, unspecified.
    pub calendar: Option<Calendar>,
    pub extra: BTreeMap<String, Value>,
}

impl Point {
    /// A whole year with nothing else stated.
    pub fn year(year: i32) -> Self {
        Self {
            stated: Stated::Year {
                year,
                month: None,
                day: None,
            },
            circa: false,
            calendar: None,
            extra: BTreeMap::new(),
        }
    }

    pub fn precision(&self) -> Precision {
        match self.stated {
            Stated::Year { day: Some(_), .. } => Precision::Day,
            Stated::Year { month: Some(_), .. } => Precision::Month,
            Stated::Year { .. } => Precision::Year,
            Stated::Decade(_) => Precision::Decade,
            Stated::Century(_) => Precision::Century,
        }
    }

    /// The first and last year the point covers.
    pub fn years(&self) -> (i32, i32) {
        match self.stated {
            Stated::Year { year, .. } => (year, year),
            Stated::Decade(d) if d > 0 => (d, d + 9),
            Stated::Decade(d) => (d - 9, d),
            Stated::Century(c) if c > 0 => ((c - 1) * 100 + 1, c * 100),
            Stated::Century(c) => (c * 100, c * 100 + 99),
        }
    }

    /// The earliest day the point covers.
    pub fn first(&self) -> DayKey {
        match self.stated {
            Stated::Year {
                year,
                month: Some(m),
                day,
            } => (year, m, day.unwrap_or(1)),
            _ => (self.years().0, 1, 1),
        }
    }

    /// The latest day the point covers. February is taken to have 29 days,
    /// since the calendar may be unspecified and nothing converts it.
    pub fn last(&self) -> DayKey {
        match self.stated {
            Stated::Year {
                year,
                month: Some(m),
                day,
            } => (year, m, day.unwrap_or_else(|| days_in_month(m))),
            _ => (self.years().1, 12, 31),
        }
    }
}

/// Whether `start` can begin no later than `end` ends. Months and days are
/// compared only when both points state the same calendar (or neither does);
/// otherwise only years are, because nothing converts calendars.
pub fn not_reversed(start: &Point, end: &Point) -> bool {
    if start.calendar == end.calendar {
        start.first() <= end.last()
    } else {
        start.years().0 <= end.years().1
    }
}

fn days_in_month(month: u8) -> u8 {
    match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

impl Serialize for Point {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self.stated {
            Stated::Year { year, month, day } => {
                map.serialize_entry("year", &year)?;
                if let Some(month) = month {
                    map.serialize_entry("month", &month)?;
                }
                if let Some(day) = day {
                    map.serialize_entry("day", &day)?;
                }
            }
            Stated::Decade(decade) => map.serialize_entry("decade", &decade)?,
            Stated::Century(century) => map.serialize_entry("century", &century)?,
        }
        if self.circa {
            map.serialize_entry("circa", &true)?;
        }
        if let Some(calendar) = self.calendar {
            map.serialize_entry("calendar", &calendar)?;
        }
        for (key, value) in &self.extra {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// How a relative dating orders its subject against another entry's aspect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TemporalOrder {
    Before,
    After,
    /// Within the other aspect, which must last (a span, activity or
    /// composition).
    During,
}

impl TemporalOrder {
    pub const ALL: [Self; 3] = [Self::Before, Self::After, Self::During];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
            Self::During => "during",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|order| order.as_str() == value)
    }
}

/// A temporal relationship: the dated aspect happened before, after or
/// during another entry's aspect. It is asserted and cited like any dating
/// and never derived from absolute dates.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct RelativeDate {
    pub order: TemporalOrder,
    /// The entry the dating is relative to.
    pub entry: String,
    pub aspect: Aspect,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// What a dating says about when its aspect happened. Exactly one form.
#[derive(Clone, Debug, PartialEq)]
pub enum DateForm {
    /// At one point, at that point's precision: `{"at": ...}`.
    At(Point),
    /// Lasting from one point to another, either end open:
    /// `{"from": ..., "to": ...}`. Only for an aspect that lasts.
    Span {
        from: Option<Point>,
        to: Option<Point>,
    },
    /// At some time inside a window, either end open (an open end is "before"
    /// or "after"): `{"notBefore": ..., "notAfter": ...}`. Both ends are
    /// inclusive.
    Window {
        not_before: Option<Point>,
        not_after: Option<Point>,
    },
    /// The party says the date is unknown: `{"unknown": true}`. Never coerced
    /// to a point.
    Unknown,
    /// Before, after or during another entry's aspect: `{"relative": ...}`.
    Relative(RelativeDate),
}

/// A date expression with any unknown fields it carried.
#[derive(Clone, Debug, PartialEq)]
pub struct DateExpr {
    pub form: DateForm,
    pub extra: BTreeMap<String, Value>,
}

impl Serialize for DateExpr {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match &self.form {
            DateForm::At(point) => map.serialize_entry("at", point)?,
            DateForm::Span { from, to } => {
                if let Some(from) = from {
                    map.serialize_entry("from", from)?;
                }
                if let Some(to) = to {
                    map.serialize_entry("to", to)?;
                }
            }
            DateForm::Window {
                not_before,
                not_after,
            } => {
                if let Some(point) = not_before {
                    map.serialize_entry("notBefore", point)?;
                }
                if let Some(point) = not_after {
                    map.serialize_entry("notAfter", point)?;
                }
            }
            DateForm::Unknown => map.serialize_entry("unknown", &true)?,
            DateForm::Relative(relative) => map.serialize_entry("relative", relative)?,
        }
        for (key, value) in &self.extra {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// Where a dating falls for ordering. Only stated values are used, with no
/// calendar conversion, and ordering is for display: it never relates two
/// datings or the things they date.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChronoKey {
    /// An absolute date: its earliest and latest day, with an open start
    /// before every year and an open end after every year.
    Dated { start: DayKey, end: DayKey },
    /// Placed only against another entry, so it has no absolute position.
    Relative,
    /// Stated to be unknown.
    Unknown,
}

const OPEN_START: DayKey = (i32::MIN, 0, 0);
const OPEN_END: DayKey = (i32::MAX, 13, 32);

impl DateExpr {
    pub fn key(&self) -> ChronoKey {
        let ends = |a: &Option<Point>, b: &Option<Point>| ChronoKey::Dated {
            start: a.as_ref().map_or(OPEN_START, Point::first),
            end: b.as_ref().map_or(OPEN_END, Point::last),
        };
        match &self.form {
            DateForm::At(point) => ChronoKey::Dated {
                start: point.first(),
                end: point.last(),
            },
            DateForm::Span { from, to } => ends(from, to),
            DateForm::Window {
                not_before,
                not_after,
            } => ends(not_before, not_after),
            DateForm::Relative(_) => ChronoKey::Relative,
            DateForm::Unknown => ChronoKey::Unknown,
        }
    }

    /// The form with every unknown field removed, so two datings that state
    /// the same thing compare equal.
    fn statement(&self) -> DateForm {
        let bare = |point: &Point| Point {
            extra: BTreeMap::new(),
            ..point.clone()
        };
        let bare_opt = |point: &Option<Point>| point.as_ref().map(bare);
        match &self.form {
            DateForm::At(point) => DateForm::At(bare(point)),
            DateForm::Span { from, to } => DateForm::Span {
                from: bare_opt(from),
                to: bare_opt(to),
            },
            DateForm::Window {
                not_before,
                not_after,
            } => DateForm::Window {
                not_before: bare_opt(not_before),
                not_after: bare_opt(not_after),
            },
            DateForm::Unknown => DateForm::Unknown,
            DateForm::Relative(relative) => DateForm::Relative(RelativeDate {
                extra: BTreeMap::new(),
                ..relative.clone()
            }),
        }
    }
}

/// One party's attributed, cited claim about when an aspect happened.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Dating {
    /// A lowercase slug unique across the atlas's entries, relationships and
    /// datings, so a page or a warning can name it.
    pub id: String,
    pub aspect: Aspect,
    pub date: DateExpr,
    #[serde(rename = "assertedBy")]
    pub asserted_by: Attribution,
    /// How firmly the asserting party holds the dating, never how widely it
    /// is accepted.
    pub confidence: Confidence,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<Evidence>,
    /// The explicit draft state of a dating that cites nothing yet; written
    /// only when true. An unsourced dating can be neither strong nor approved.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unsourced: bool,
    /// The author's note: what is doubtful, how the party reckons the date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub visibility: Visibility,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Dating {
    /// The other entry a relative dating points at.
    pub fn relative_target(&self) -> Option<&RelativeDate> {
        match &self.date.form {
            DateForm::Relative(relative) => Some(relative),
            _ => None,
        }
    }

    pub fn key(&self) -> ChronoKey {
        self.date.key()
    }
}

/// Order two datings by where they fall, then by id, so the result is the
/// same however the file lists them. Circa does not move a point, relative
/// datings follow every absolute one, and unknown datings come last.
pub fn chronological(a: &Dating, b: &Dating) -> Ordering {
    a.key().cmp(&b.key()).then_with(|| a.id.cmp(&b.id))
}

/// Datings grouped by aspect, each group in file order. Competing datings of
/// one aspect stay side by side; none is preferred, merged or dropped.
pub fn by_aspect(dates: &[Dating]) -> BTreeMap<Aspect, Vec<&Dating>> {
    let mut groups: BTreeMap<Aspect, Vec<&Dating>> = BTreeMap::new();
    for dating in dates {
        groups.entry(dating.aspect).or_default().push(dating);
    }
    groups
}

/// What owns a list of datings, which decides the aspects it may use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Owner {
    /// An entry; its kind is unknown when the kind itself failed to read.
    Entry(Option<EntryKind>),
    Relationship,
}

fn whole(ctx: &mut Ctx<'_>, obj: &mut Obj, key: &str) -> Option<i64> {
    let field = obj.field(key);
    match obj.map.remove(key) {
        None => None,
        Some(Value::Number(n)) if n.as_i64().is_some() => n.as_i64(),
        Some(_) => {
            ctx.report(
                AtlasDiagnosticCode::InvalidField,
                &field,
                "must be a whole number",
            );
            None
        }
    }
}

const POINT_KEYS: &str = "`year`, `decade` or `century`";

fn parse_point(ctx: &mut Ctx<'_>, mut obj: Obj) -> Option<Point> {
    let before = ctx.failed;
    ctx.failed = false;
    let named = ["year", "decade", "century"]
        .iter()
        .any(|key| obj.map.contains_key(*key));
    let year = whole(ctx, &mut obj, "year");
    let month = whole(ctx, &mut obj, "month");
    let day = whole(ctx, &mut obj, "day");
    let decade = whole(ctx, &mut obj, "decade");
    let century = whole(ctx, &mut obj, "century");
    let circa = obj.flag(ctx, "circa");
    let calendar_field = obj.field("calendar");
    let calendar = match obj.map.remove("calendar") {
        None => None,
        Some(Value::String(text)) if text == "gregorian" => Some(Calendar::Gregorian),
        Some(Value::String(text)) if text == "julian" => Some(Calendar::Julian),
        Some(_) => {
            ctx.report(
                AtlasDiagnosticCode::InvalidField,
                &calendar_field,
                "use `gregorian` or `julian`; record any other reckoning in the note, since nothing converts calendars",
            );
            None
        }
    };
    let invalid = |ctx: &mut Ctx<'_>, key: &str, message: &str| {
        let field = if key.is_empty() {
            obj.path.clone()
        } else {
            obj.field(key)
        };
        ctx.report(AtlasDiagnosticCode::InvalidDate, &field, message);
    };
    let stated_count = [year.is_some(), decade.is_some(), century.is_some()]
        .iter()
        .filter(|present| **present)
        .count();
    let stated = match (year, decade, century) {
        _ if stated_count > 1 => {
            invalid(ctx, "", &format!("state exactly one of {POINT_KEYS}"));
            None
        }
        (Some(y), None, None) => {
            let year = i32::try_from(y)
                .ok()
                .filter(|y| *y != 0 && y.abs() <= MAX_YEAR);
            if year.is_none() {
                invalid(
                    ctx,
                    "year",
                    &format!("must be a whole year between -{MAX_YEAR} and {MAX_YEAR}; negative is BCE and there is no year 0"),
                );
            }
            let month = month.and_then(|m| match u8::try_from(m) {
                Ok(m) if (1..=12).contains(&m) => Some(m),
                _ => {
                    invalid(ctx, "month", "must be a month from 1 to 12");
                    None
                }
            });
            let day = day.and_then(|d| match (month, u8::try_from(d)) {
                (None, _) => {
                    invalid(ctx, "day", "a day needs a month");
                    None
                }
                (Some(m), Ok(d)) if d >= 1 && d <= days_in_month(m) => Some(d),
                (Some(_), _) => {
                    invalid(ctx, "day", "is not a day of that month");
                    None
                }
            });
            year.map(|year| Stated::Year { year, month, day })
        }
        (None, Some(d), None) => {
            let decade = i32::try_from(d).ok().filter(|d| {
                *d != 0 && d % 10 == 0 && (d - 9).abs() <= MAX_YEAR && (d + 9).abs() <= MAX_YEAR
            });
            if decade.is_none() {
                invalid(
                    ctx,
                    "decade",
                    &format!("must be a non-zero multiple of 10 between -{MAX_YEAR} and {MAX_YEAR}: `1380` is 1380 to 1389, `-380` is 389 to 380 BCE"),
                );
            }
            decade.map(Stated::Decade)
        }
        (None, None, Some(c)) => {
            let century = i32::try_from(c)
                .ok()
                .filter(|c| *c != 0 && c.abs() <= MAX_CENTURY);
            if century.is_none() {
                invalid(
                    ctx,
                    "century",
                    &format!("must be a century from -{MAX_CENTURY} to {MAX_CENTURY} other than 0: `-4` is the 4th century BCE"),
                );
            }
            century.map(Stated::Century)
        }
        // A precision that was given but could not be read has said why.
        _ if named => None,
        _ => {
            ctx.report(
                AtlasDiagnosticCode::MissingField,
                &obj.field("year"),
                format!("state one of {POINT_KEYS}"),
            );
            None
        }
    };
    if year.is_none() && (month.is_some() || day.is_some()) && stated_count > 0 {
        let key = if month.is_some() { "month" } else { "day" };
        invalid(ctx, key, "a month or day needs a year");
    }
    if calendar.is_some() && month.is_none() {
        invalid(
            ctx,
            "calendar",
            "a calendar only applies to a stated month and day; years are always historical BCE/CE years",
        );
    }
    let failed = ctx.failed;
    ctx.failed = before || failed;
    let stated = stated.filter(|_| !failed)?;
    Some(Point {
        stated,
        circa,
        calendar,
        extra: obj.rest(),
    })
}

const FORMS: &str = "`at`, `from`/`to`, `notBefore`/`notAfter`, `unknown` or `relative`";

fn parse_relative(ctx: &mut Ctx<'_>, mut obj: Obj) -> Option<RelativeDate> {
    let order_field = obj.field("order");
    let order = match obj.map.remove("order") {
        Some(Value::String(text)) => {
            let order = TemporalOrder::parse(&text);
            if order.is_none() {
                ctx.report(
                    AtlasDiagnosticCode::UnknownKind,
                    &order_field,
                    "use before, after, or during",
                );
            }
            order
        }
        Some(_) => {
            ctx.report(
                AtlasDiagnosticCode::InvalidField,
                &order_field,
                "must be a string",
            );
            None
        }
        None => {
            ctx.report(
                AtlasDiagnosticCode::MissingField,
                &order_field,
                "is required",
            );
            None
        }
    };
    let entry = obj.id(ctx, "entry", "entry identifier", true);
    let aspect = parse_aspect(ctx, &mut obj);
    if order == Some(TemporalOrder::During) && aspect.is_some_and(|a| !a.is_durative()) {
        let field = obj.field("aspect");
        ctx.report(
            AtlasDiagnosticCode::AspectKind,
            &field,
            "`during` needs an aspect that lasts: span, active, or composition",
        );
    }
    Some(RelativeDate {
        order: order?,
        entry: entry?,
        aspect: aspect?,
        extra: obj.rest(),
    })
}

fn parse_aspect(ctx: &mut Ctx<'_>, obj: &mut Obj) -> Option<Aspect> {
    let field = obj.field("aspect");
    match obj.map.remove("aspect") {
        Some(Value::String(text)) => {
            let aspect = Aspect::parse(&text);
            if aspect.is_none() {
                let names: Vec<&str> = Aspect::ALL.iter().map(|a| a.as_str()).collect();
                ctx.report(
                    AtlasDiagnosticCode::UnknownKind,
                    &field,
                    format!("use one of: {}", names.join(", ")),
                );
            }
            aspect
        }
        Some(_) => {
            ctx.report(
                AtlasDiagnosticCode::InvalidField,
                &field,
                "must be a string",
            );
            None
        }
        None => {
            ctx.report(AtlasDiagnosticCode::MissingField, &field, "is required");
            None
        }
    }
}

fn parse_date(ctx: &mut Ctx<'_>, mut obj: Obj) -> Option<DateExpr> {
    let has = |key: &str| obj.map.contains_key(key);
    let forms = [
        has("at"),
        has("from") || has("to"),
        has("notBefore") || has("notAfter"),
        has("unknown"),
        has("relative"),
    ];
    let path = obj.path.clone();
    match forms.iter().filter(|f| **f).count() {
        0 => {
            ctx.report(
                AtlasDiagnosticCode::MissingField,
                &path,
                format!("state one of {FORMS}"),
            );
            return None;
        }
        1 => {}
        _ => {
            ctx.report(
                AtlasDiagnosticCode::InvalidDate,
                &path,
                format!("state exactly one of {FORMS}; record a competing date as its own dating"),
            );
            return None;
        }
    }
    let point = |ctx: &mut Ctx<'_>, obj: &mut Obj, key: &str| {
        obj.object(ctx, key, false)
            .and_then(|o| parse_point(ctx, o))
    };
    let form = if forms[0] {
        DateForm::At(point(ctx, &mut obj, "at")?)
    } else if forms[1] || forms[2] {
        let (start_key, end_key) = if forms[1] {
            ("from", "to")
        } else {
            ("notBefore", "notAfter")
        };
        let start = point(ctx, &mut obj, start_key);
        let end = point(ctx, &mut obj, end_key);
        if let (Some(start), Some(end)) = (&start, &end) {
            if !not_reversed(start, end) {
                let field = obj.field(end_key);
                ctx.report(
                    AtlasDiagnosticCode::InvalidDate,
                    &field,
                    format!("`{start_key}` must not be later than `{end_key}`"),
                );
            }
        }
        if start.is_none() && end.is_none() {
            // Whatever was there failed to read and has said why.
            return None;
        }
        if forms[1] {
            DateForm::Span {
                from: start,
                to: end,
            }
        } else {
            DateForm::Window {
                not_before: start,
                not_after: end,
            }
        }
    } else if forms[3] {
        let field = obj.field("unknown");
        match obj.map.remove("unknown") {
            Some(Value::Bool(true)) => DateForm::Unknown,
            _ => {
                ctx.report(
                    AtlasDiagnosticCode::InvalidField,
                    &field,
                    "must be true; to state a date use another form, and to state nothing remove the dating",
                );
                return None;
            }
        }
    } else {
        let relative = obj.object(ctx, "relative", true)?;
        DateForm::Relative(parse_relative(ctx, relative)?)
    };
    Some(DateExpr {
        form,
        extra: obj.rest(),
    })
}

fn parse_dating(ctx: &mut Ctx<'_>, path: &str, raw: Value, owner: Owner) -> Option<Dating> {
    let Value::Object(map) = raw else {
        ctx.report(AtlasDiagnosticCode::InvalidField, path, "must be an object");
        return None;
    };
    let mut obj = Obj {
        path: path.into(),
        map,
    };
    let before = ctx.failed;
    ctx.failed = false;
    let id = obj.id(ctx, "id", "dating identifier", true);
    obj.reject_credits(ctx);
    let visibility = obj.visibility(ctx);
    let aspect = parse_aspect(ctx, &mut obj);
    let date = obj
        .object(ctx, "date", true)
        .and_then(|o| parse_date(ctx, o));
    let asserted_by = obj
        .object(ctx, "assertedBy", true)
        .and_then(|o| parse_attribution(ctx, o));
    let confidence_field = obj.field("confidence");
    let confidence = match obj.map.remove("confidence") {
        None => Some(Confidence::Tentative),
        Some(Value::String(text)) => {
            let confidence = Confidence::parse(&text);
            if confidence.is_none() {
                ctx.report(
                    AtlasDiagnosticCode::InvalidField,
                    &confidence_field,
                    "use tentative, plausible, or strong",
                );
            }
            confidence
        }
        Some(_) => {
            ctx.report(
                AtlasDiagnosticCode::InvalidField,
                &confidence_field,
                "must be a string",
            );
            None
        }
    };
    let declared = obj
        .map
        .get("evidence")
        .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty));
    let evidence = parse_evidence_list(ctx, &mut obj, "evidence");
    let unsourced = obj.flag(ctx, "unsourced");
    let field = |key: &str| obj.field(key);
    if declared && evidence.is_empty() {
        // The evidence field already reported why it could not be read.
    } else if evidence.is_empty() && !unsourced {
        ctx.report(
            AtlasDiagnosticCode::MissingEvidence,
            &field("evidence"),
            "cite at least one source for this dating, or mark it `\"unsourced\": true` as a draft",
        );
    } else if !evidence.is_empty() && unsourced {
        ctx.report(
            AtlasDiagnosticCode::EvidenceConflict,
            &field("unsourced"),
            "a dating that cites evidence is not unsourced; remove the flag",
        );
    }
    if unsourced && confidence == Some(Confidence::Strong) {
        ctx.report(
            AtlasDiagnosticCode::EvidenceConflict,
            &field("confidence"),
            "an unsourced dating cannot be strong; cite evidence first",
        );
    }
    if visibility == Visibility::Approved {
        if unsourced {
            ctx.report(
                AtlasDiagnosticCode::MissingEvidence,
                &field("visibility"),
                "an unsourced dating cannot be approved; cite evidence first",
            );
        }
        if evidence.iter().any(|e| e.passage.is_some()) {
            ctx.report(
                AtlasDiagnosticCode::PrivateReference,
                &field("visibility"),
                "an approved dating cannot carry a pointer into the private notebook; cite the source and locators instead",
            );
        }
    }
    if let Some(aspect) = aspect {
        let allowed = match owner {
            Owner::Entry(Some(kind)) => aspect.applies_to(kind).then_some(()).ok_or_else(|| {
                let names: Vec<&str> = Aspect::of_entry(kind).iter().map(|a| a.as_str()).collect();
                format!(
                    "a {} entry can be dated by: {}",
                    kind.as_str(),
                    names.join(", ")
                )
            }),
            Owner::Entry(None) => Ok(()),
            Owner::Relationship => (aspect == Aspect::Span).then_some(()).ok_or_else(|| {
                "a relationship is dated only by its `span`, when it held".to_string()
            }),
        };
        if let Err(message) = allowed {
            ctx.report(AtlasDiagnosticCode::AspectKind, &field("aspect"), message);
        }
        if !aspect.is_durative()
            && matches!(date.as_ref().map(|d| &d.form), Some(DateForm::Span { .. }))
        {
            ctx.report(
                AtlasDiagnosticCode::AspectKind,
                &field("date"),
                format!("a {} happens at one time; give a window with `notBefore`/`notAfter` instead of a span", aspect.as_str()),
            );
        }
    }
    let note = obj.text(ctx, "note", false, MAX_UNCERTAINTY_CHARS, true);
    let failed = ctx.failed;
    ctx.failed = before || failed;
    if failed {
        return None;
    }
    Some(Dating {
        id: id?,
        aspect: aspect?,
        date: date?,
        asserted_by: asserted_by?,
        confidence: confidence?,
        evidence,
        unsourced,
        note,
        visibility,
        extra: obj.rest(),
    })
}

/// Read an item's `dates`. Each dating is checked on its own; whether its
/// sources, passages and relative target exist is decided with the atlas.
pub(crate) fn parse_dates(ctx: &mut Ctx<'_>, obj: &mut Obj, owner: Owner) -> Vec<Dating> {
    let base = obj.field("dates");
    let mut dates: Vec<Dating> = Vec::new();
    for (position, raw) in obj.array(ctx, "dates", MAX_DATINGS).into_iter().enumerate() {
        let path = format!("{base}[{position}]");
        let Some(dating) = parse_dating(ctx, &path, raw, owner) else {
            continue;
        };
        let party = |d: &Dating| {
            (
                d.asserted_by.kind,
                d.asserted_by.source.clone(),
                d.asserted_by.name.clone(),
            )
        };
        if dates.iter().any(|other| {
            other.aspect == dating.aspect
                && party(other) == party(&dating)
                && other.date.statement() == dating.date.statement()
        }) {
            ctx.report(
                AtlasDiagnosticCode::DuplicateDating,
                &format!("{path}.date"),
                "this party already gives this date for this aspect; a competing date is welcome, a repeated one is not",
            );
        }
        dates.push(dating);
    }
    dates
}
