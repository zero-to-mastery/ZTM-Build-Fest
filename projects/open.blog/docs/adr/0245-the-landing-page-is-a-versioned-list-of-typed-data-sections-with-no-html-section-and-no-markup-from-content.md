# ADR 0245: The landing page is a versioned list of typed data sections, with no HTML section and no markup from content

- Status: Accepted
- Superseded in part by: ADR 0253 (embedded video and map frames are no longer deferred)
- Date: 2026-10-28
- Decision issue: [#322](https://github.com/journey-to-code-org/open.blog/issues/322)
- Parent story: [#315](https://github.com/journey-to-code-org/open.blog/issues/315)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Serves: [#323](https://github.com/journey-to-code-org/open.blog/issues/323), [#324](https://github.com/journey-to-code-org/open.blog/issues/324), [#325](https://github.com/journey-to-code-org/open.blog/issues/325)
- Contract: `openblog_core::landing`

## Context

The home page is fixed today: an optional Markdown intro, the post list and the series cards, driven by
`home.heading`, `home.intro` and `home.showSeries` in `openblog.json`. The epic lets a non-programmer arrange
it. The stored format is a one-way door: once owners have files in it, every later release must read them and
none may destroy what it does not understand. So the format is chosen to be small, versioned and conservative.

## Decision

- **One file, `<content>/landing.json`.** `{ format: "openblog-landing", version: 1, sections: [...] }`. It is
  public, author-written text beside the content (the idiom of `paths/*.json` and `third-perspectives.json`),
  and a site without it is exactly the site it was. `openblog.json` is not touched by saving a section.
- **Sections are a closed set of typed data.** `welcome`, `rich-text`, `latest-posts`, `series`,
  `featured-post`, `buttons`, `image`, `video`, `map`, `opening-hours`, `contact`, `social-links`, `faq`,
  `callout`. Each has a stable `id` (lowercase letters, digits, single hyphens, at most 64 bytes, unique) and a
  `hidden` flag. **There is no HTML section type and no field whose value is read as markup.** A button is a
  label and an address; a video is a provider and the provider's id, never an address or embed code; a map is
  coordinates and a label.
- **Only Markdown is rich, and it is inert.** `rich-text`, FAQ answers and call-out bodies are Markdown. The
  landing renderer reads it with raw HTML disabled: a tag, script or iframe is shown as escaped text; links and
  images keep only `https`, `mailto`, `tel` and relative addresses; headings are set at one level and carry no
  author attributes.
- **Conservative validation.** At most 40 sections, 256 KiB, bounded text lengths and item counts, `latest-posts`
  count 1 to 50. Addresses are `https`, `mailto`, `tel` or relative (buttons), `https` or relative (images) and
  `https` only (social links); `http`, `javascript:`, `data:`, protocol-relative, whitespace and control
  characters are refused. Video providers are `youtube` and `vimeo` (a provider-shaped id); the map provider is
  `openstreetmap`; image alt text is required. The page is accepted whole or not at all.
- **Versions and the future.** A file with a newer `version` is refused with a message that says it was not
  changed and will not be overwritten. Fields this release does not define, on the file or on a section, are
  kept as written and written back. A section **type** this release does not define is refused rather than
  guessed at: a new type is a new version, so an old release never half-renders or drops a section.
- **Canonical form.** `to_canonical_json` writes sorted keys, two-space indent and one trailing newline, so an
  Admin save and a hand edit agree byte for byte.
- **Legacy mapping.** `from_legacy(home)` gives three sections: `intro` (rich text, hidden when empty),
  `latest` (latest posts under `home.heading`, count absent meaning the site's posts per page) and `series`
  (hidden when `showSeries` is false). `legacy_home()` gives the settings back, so the mapping is lossless.
  The settings keep working: **no `landing.json` means unchanged output, byte for byte.** A present file
  replaces them for the home page.
- **Raw HTML in Markdown mode** (should Admin's Markdown editor stop accepting new raw HTML?) is flagged and not
  decided here. Landing content never accepts it either way.

## Considered options

- **Sections inside `openblog.json`.** Rejected: Admin would rewrite unrelated config on every save and
  conflicts would span unrelated settings.
- **A free `html` or `embed` section.** Rejected by the epic: it is the one door that makes the site breakable.
- **Unknown section types preserved and skipped at render.** Rejected for 1.0 of the format: an older release
  would hide content the owner can see in a newer Admin. A new type bumps the version instead.
- **Video and map as embedded frames.** Deferred: LB1 renders a plain link to the provider, which needs no
  script, frame or third-party load. A later version may add a consented embed.

## Consequences

- #323 stores and serves the file atomically with a revision (SHA-256 of the bytes).
- #324 renders from the validated value only and escapes every field.
- The format can grow by adding optional fields (kept by older releases) without a version bump, and by adding
  types with one.

## Domain language

**Landing page** and **Landing section** are defined in [`CONTEXT.md`](../../CONTEXT.md).
