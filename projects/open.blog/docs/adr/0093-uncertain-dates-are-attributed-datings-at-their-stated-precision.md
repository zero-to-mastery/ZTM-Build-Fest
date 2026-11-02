# ADR 0093: Uncertain dates are attributed datings at their stated precision

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#56](https://github.com/journey-to-code-org/open.blog/issues/56)
- Parent story: [#23](https://github.com/journey-to-code-org/open.blog/issues/23)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0053](0053-knowledge-atlas-entries-keep-their-kind.md),
  [ADR 0054](0054-attributed-evidence-based-relationships.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#chronology)

## Context

ADR 0053 kept a coarse `bounds` year range on atlas entries for display and promised a
chronology contract to replace it. Historical dates are rarely exact. "c. 428 BCE", "the 380s
BCE", "4th century BCE", "after 399 BCE", "between 387 and 367 BCE" and "unknown" are all
different statements, and two sources often date the same thing differently. A single year
field forces a false exact date, picks one source over another without saying so, and invites
tools to treat the date as fact.

## Decision

- **A dating is one party's claim.** Entries and relationships carry `dates`, a list of
  *datings* owned by `openblog_core::chronology`. Each dating has an `id` (a slug in the
  atlas's one identifier space), the `aspect` it dates, a `date` expression, `assertedBy` (the
  atlas attribution: author, source or named party), `confidence` (`tentative` default,
  `plausible`, `strong`: how firmly that party holds it), `evidence` (the atlas evidence object
  and its locator rules) or the explicit `"unsourced": true` draft state, an optional `note`,
  and `visibility`. Evidence and the flag together are a contradiction; an unsourced dating can
  be neither strong nor approved; contributor credits are refused. Unknown fields are kept at
  every level.
- **Aspects are typed by owner.** `span` (the whole period something existed, lasted or held:
  a lifetime, an event's duration) applies to every entry and is the only aspect of a
  relationship. `birth` and `death` are a person's, `active` (floruit) a person's or a
  movement's, `composition` and `publication` a work's, and `emergence` a concept's or a
  movement's. Only `span`, `active` and `composition` last.
- **Five date forms, exactly one per dating.** `{"at": P}` is one point at its precision.
  `{"from": P, "to": P}` is a duration, either end open, only for an aspect that lasts.
  `{"notBefore": P, "notAfter": P}` is a window inside which a thing happened, either end open,
  both ends inclusive: an open end is "after" or "before". `{"unknown": true}` says the date is
  unknown. `{"relative": ...}` is a temporal relationship ([ADR 0094](0094-temporal-relationships-are-relative-datings-never-inferred.md)).
  A birth given as a duration is refused, since a birth happens once and its uncertainty is a
  window.
- **A point states one precision.** `{"year": Y}` optionally with `month`, and `day` only with
  a month; `{"decade": D}` named as decades are named (`1380` is 1380 to 1389, `-380` is 389 to
  380 BCE); `{"century": C}` by ordinal (`-4` is 400 to 301 BCE). `"circa": true` marks it
  approximate. Nothing widens, narrows or rounds a point: what is written is read back.
- **Historical years, no year 0.** Negative is BCE and 1 BCE (`-1`) is followed directly by
  1 CE (`1`); year, decade and century 0 are refused; years stay within ±100,000. A start
  that begins after its end ends is refused.
- **Calendars are named, never converted.** `calendar` (`gregorian` or `julian`) applies only
  to a stated month and is refused on a bare year. Absent means as the cited party gives it.
  Months and days are compared only when two points state the same calendar (or neither does);
  otherwise only years are. February has 29 days for validation because the calendar may be
  unspecified. Other reckonings (regnal years, Olympiads) belong in the `note`. There is no
  conversion engine.
- **Unknown is a statement, not a missing value.** `{"unknown": true}` is kept and sorted after
  every dated item; `false`, an empty `date`, and a point with no year, decade or century are
  refused rather than turned into a date. An entry with no datings is simply undated.
- **Competing datings stand side by side.** Any number of parties may date the same aspect,
  and the same party may offer alternatives; only the same party repeating the same date for
  the same aspect is refused. There is no preferred, resolved, consensus or "accepted" field,
  and nothing picks, averages or merges datings. `chronology::by_aspect` groups them in file
  order.
- **Order is for display only.** `DateExpr::key` places a dating by its earliest and latest
  stated day (open start first, open end last), then relative datings, then unknown ones;
  `chronology::chronological` breaks ties by id. Circa does not move a point and no calendar is
  converted. The order never relates two datings or the things they date.
- **Validation is all or nothing and scoped.** Diagnostics name the owning entry or
  relationship and the field path (`dates[1].date.at.month`) and never repeat authored text.
  New codes are `invalid-date`, `aspect-kind` and `duplicate-dating`. A dating's sources and
  passages count as uses of them, so the library and notebook refuse to remove them.

## Consequences

- The chronology index (#57) can sort partial dates deterministically from `DateExpr::key` and
  explain warnings by dating id and cited values; it must not drop circa or unknown datings.
- Admin exploration (#58) and publication (#59) show every dating with its attribution,
  precision and uncertainty, never a single collapsed year.
- Calendar conversion and automatic reconciliation stay out of scope.

## Domain language

**Dating**, **Date expression**, **Dated aspect**, **Date precision**, **Circa**, **Date
window**, **Unknown date**, **Competing datings** and **Calendar policy** are defined in
[`CONTEXT.md`](../../CONTEXT.md).
