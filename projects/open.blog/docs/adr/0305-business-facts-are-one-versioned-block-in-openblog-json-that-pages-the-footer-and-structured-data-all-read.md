# ADR 0305: Business facts are one versioned block in openblog.json that pages, the footer and structured data all read

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#482](https://github.com/journey-to-code-org/open.blog/issues/482)
- Task: [#506](https://github.com/journey-to-code-org/open.blog/issues/506)
- Parent epic: [#473](https://github.com/journey-to-code-org/open.blog/issues/473)
- Builds on: [ADR 0285](0285-jobs-are-posts-with-a-content-profile-and-open-blog-is-not-a-field-service-tool.md), [ADR 0248](0248-the-owner-s-look-is-a-small-versioned-set-of-typed-presets-stored-under-appearance-and-compiled-only-into-allowlisted-tokens.md)

## Context

A tradesperson's name, phone, hours, license and insurance appear in the footer, on a contact page, in
structured data and in a few paragraphs of prose. Typed in each place, they drift. Search engines reward
consistent name, phone and hours, and customers lose trust when two pages disagree. The facts are a one-way
door once owners write them into `openblog.json`, so the shape must be small, versioned and conservative.

## Decision

- **One object, `business`, in `openblog.json`**, owned by `openblog_core::business::BusinessConfig` and read
  by everything else. It is *settings*, not content: the same file and the same save route as the rest of the
  configuration (ADR 0307), unlike the landing page, which is a document of its own.
- **Versioned like `appearance`.** `version: 1` is the only version read or written. A newer one is refused
  with a message that says to update, and the file is not changed. Fields this release does not define are kept
  as written and written back, so a newer engine's settings survive an older one. Every field is optional; an
  unset block is the default, is **omitted from the written file** and changes no page.
- **Fields.** `legalName`, `displayName` (each at most 120 characters, one line); `trade` (a job trade id,
  checked against the bundled trades and `extraTrades`); `phone`; `email`; `hours`; `licenseNumber` (40) and
  `licenseIssuer` (80, needs the number); `insured` (a flag); `paymentMethods`; `foundedYear` (1800 to 2100).
  There is no free text field that is read as markup, no address (service areas own places, story #484) and
  nothing about customers.
- **Phone is stored as E.164 and formatted on render.** The stored form is `+`, a country code that does not
  start with 0, and 8 to 15 digits in all, with no separators. Anything else fails with a message that shows
  the shape (`+14155550123`). Rendering turns a US or Canada number into `(415) 555-0123` and leaves other
  countries as stored; the link is always `tel:` plus the stored value. Admin accepts what an owner types and
  converts it (`normalize_phone_input`: separators dropped, ten digits read as `+1`), so the file itself stays
  strict.
- **Hours are per weekday, with closed days.** `hours` is an object keyed `monday` to `sunday`; each value is
  `{ "open": "HH:MM", "close": "HH:MM" }` or `{ "closed": true }`. One range per day, 24-hour times, close after
  open, `24:00` allowed as a close for round-the-clock days. A day that runs past midnight is **not supported**:
  it would need a second range or a next-day rule, and a wrong guess publishes wrong hours. A day left out is
  "not stated", which is different from closed.
- **Payment methods are a closed enum:** `cash`, `check`, `credit-card`, `debit-card`, `bank-transfer`,
  `mobile-payment`, `financing`. It names kinds of payment and can never hold an account or a card, which keeps
  the "no payment data" rule of ADR 0285. Unknown values are refused with the list; duplicates collapse.
- **`insured` is the owner's claim.** The engine shows "Licensed and insured" only when a license number is
  stated and `insured` is true ("Licensed" or "Insured" when only one holds). It verifies nothing and says so
  in the docs.
- **The trade picks the structured-data type.** `schema_type_for_trade` maps `general-contractor` to
  `GeneralContractor`, `roofing` to `RoofingContractor`, `plumbing` to `Plumber`, `electrical` to
  `Electrician`, `hvac` to `HVACBusiness`, `painting` to `HousePainter`, `mobile-mechanic` to `AutoRepair`,
  `auto-body-paint` to `AutoBodyShop`, `locksmith` to `Locksmith`, and `excavation`, `flooring` and
  `landscaping` (no schema.org type of their own) to `HomeAndConstructionBusiness`. Anything else is
  `LocalBusiness`.
- **Errors are plain and name the field** (`business: phone must include the country code and digits only,
  like +14155550123`), are all reported together, and fail the build and the Admin save.

## Considered options

- **A `business.json` or `content/business.md` beside the content.** Rejected: these are site-wide settings
  like `author`, `appearance` and `seo`, and the Settings save route already has revisions, validation and
  key-order preservation (ADR 0307).
- **Free-text hours ("Mon to Fri 8 to 5").** Rejected: it cannot be formatted consistently or turned into
  `openingHoursSpecification`.
- **Accepting formatted phones in the file.** Rejected: the file would hold several spellings of one number.
- **Several ranges per day.** Deferred: a lunch break is rarely published, and a later version can add a list
  without breaking this one.
- **Reusing the landing `opening-hours` and `contact` sections as the source.** Rejected: they are
  free-text display rows for one page; the facts need one typed source for every page.

## Consequences

- Rendering and structured data (ADR 0306) and the Settings panel (ADR 0307) read this value and never keep
  their own copy.
- Adding a field is an optional field in version 1; changing the meaning of one is version 2 with a
  documented upgrade.

## Domain language

**Business facts** is defined in [`CONTEXT.md`](../../CONTEXT.md).
