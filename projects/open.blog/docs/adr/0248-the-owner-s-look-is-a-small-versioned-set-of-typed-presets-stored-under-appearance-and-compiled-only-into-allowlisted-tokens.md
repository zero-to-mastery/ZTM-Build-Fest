# ADR 0248: The owner's look is a small, versioned set of typed presets stored under `appearance` and compiled only into allowlisted tokens

- Status: Accepted
- Date: 2026-10-28
- Parent story: [#343](https://github.com/journey-to-code-org/open.blog/issues/343)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Decision issues: [#344](https://github.com/journey-to-code-org/open.blog/issues/344), [#345](https://github.com/journey-to-code-org/open.blog/issues/345), [#346](https://github.com/journey-to-code-org/open.blog/issues/346), [#347](https://github.com/journey-to-code-org/open.blog/issues/347), [#348](https://github.com/journey-to-code-org/open.blog/issues/348), [#349](https://github.com/journey-to-code-org/open.blog/issues/349)
- Builds on: the theme token compiler (`themes/<name>/theme.json`, `tokens.css`)

## Context

An owner who is not a programmer should be able to make the site feel like theirs by choosing a palette, an
accent color, a font style and a few sizes, and never be able to make the text unreadable or inject a style
rule. Themes already compile typed tokens into `--ob-*` custom properties and `web/base.css` reads nothing
else, so the look can be a thin, validated layer over those tokens. The storage shape is a one-way door:
once sites hold it, every later engine has to read it.

## Decision

- **Storage.** The look is the top-level `appearance` object of `openblog.json`, beside the existing
  `colorSchemeToggle`. It is versioned (`"version": 1`) and holds only the controls the owner chose:
  `accent` (a strict hex color), `palette` (a curated look id), `fontStyle`, `textSize`, `roundness`,
  `spacing`, `pageWidth` and `headingWeight` (each a closed enum). A missing object, `{}` and an object of
  defaults all mean "the theme as it is". The engine writes `{}` as no key at all, so resetting everything
  removes `appearance`.
- **Conservative reads.** A missing `version` is read as 1 (a hand edit stays friendly) and is always written
  back. A newer version is rejected with a message, never half-read, so an older engine never rewrites a
  newer engine's settings. Unknown fields inside `appearance` are kept and written back untouched and are
  never read when compiling CSS. A bad value fails the whole object with every problem listed in plain
  words; nothing is repaired silently.
- **No free text.** The only string that is not an enum is the accent, and it must be `#rgb` or `#rrggbb`
  hex, normalized to lowercase `#rrggbb`. Values are rejected, not escaped.
- **Compilation.** The look becomes one override block appended to a theme's `tokens.css`, after the theme's
  own tokens and per resolved theme, so per-post and series theme overrides layer on top of whichever theme
  applies. Property names and values come from fixed tables in the engine; the only computed values are
  colors derived from the validated accent and a validated palette. Output is deterministic, its content hash
  is added to the stylesheet URL (`tokens.css?v=<hash>`), and with no look the stylesheet and its URL are
  byte-identical to a site without this feature.
- **Controls per theme.** A theme may list the controls it honors in `customizable` in `theme.json`. A theme
  that omits it inherits its parent's list, and `base` honors all of them. The engine compiles, and Admin
  shows, only the controls the active theme honors; a control a theme does not honor is explained, never
  shown as if it worked.
- **Readable by construction.** A pure contrast model derives, for each scheme and each theme, an accent that
  meets WCAG AA (4.5:1) against the page and surface colors by moving lightness minimally, the readable text
  color on the accent, and soft and border tints that keep the contrast the interface needs (3:1 for
  borders). If a color had to change, the model says so in one sentence; if no lightness can pass, the
  accent is refused with a suggestion. A `prefers-contrast: more` variant targets 7:1. Forced-colors mode is
  left to the browser, which ignores author colors.
- **Curated looks are data in core.** Eight named looks (Calm, Warm, Bold, Night, Garden, Paper, Ocean,
  Sunset) each carry a complete light and dark palette and a font style. Applying one stores its `palette`
  id and font style (the palette brings its own accent; a chosen accent is then a tweak on top); resetting removes them, which returns exactly to the theme default. Every look
  is tested against the contrast model.
- **Saving.** `GET/PUT /admin/api/look` reads and saves only the `appearance` key of `openblog.json`.
  The revision is a digest of the stored look alone (not the whole file), so a save elsewhere in the file,
  such as a landing page section, neither conflicts with nor is lost to a look save; a stale revision gets a
  `409` carrying the current look and revision. The body is bounded to 4 KiB, a bad value is a `422` with
  plain messages, an accent that cannot be made readable on the site's theme is refused with a suggestion,
  and the write is atomic (temporary file, then replace) under the content transaction lock, after the
  candidate file has been loaded successfully. Authentication, CSRF and deny-by-default come from the
  existing Admin seams. Saving `{}` or `null` removes the key. Publishing follows the Appearance behavior.

## Considered options

- **A separate `look.json`.** Rejected: a second file to keep consistent, review and back up, and no gain
  over one validated object in the file Admin already writes atomically.
- **Storing derived CSS or colors.** Rejected: derived values depend on the theme and the engine's contrast
  model, which can improve; only the owner's choices are stored.
- **Free-form color for every surface.** Rejected: it cannot be kept readable in light and dark. Palettes
  are curated and the accent is derived.
- **Escaping arbitrary strings into CSS.** Rejected: allowlisting by enum makes injection unrepresentable
  rather than merely unlikely.

## Consequences

- Any engine can read `appearance` version 1 forever; a version 2 will need an explicit migration.
- Adding an enum value later is backward compatible only if older engines are allowed to reject it, which
  they do, loudly.
- A site without `appearance` builds byte-for-byte as before; `web/base.css` gained `--ob-text-scale`
  defaulting to 1.
- Saving a look rewrites `openblog.json` through serde_json (keys sorted, formatting normalized, values preserved), the same as the existing Appearance save; a byte-preserving config save is a possible future change for all Admin config saves.

## Domain language

**Look**, **Look control** and **Curated look** are defined in [`CONTEXT.md`](../../CONTEXT.md).
