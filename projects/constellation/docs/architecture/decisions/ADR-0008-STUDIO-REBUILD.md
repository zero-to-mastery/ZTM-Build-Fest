# ADR-0008: Rebuild the Studio around one screen and a settings registry

- Status: Accepted
- Date: 2026-10-22
- Supersedes: [ADR-0006](ADR-0006-GUIDED-EXPERIENCE.md) (guided experience and Simple/Advanced Studio)
- Related: [ADR-0007](ADR-0007-PORTFOLIO-ARTIFACT.md)

## Context

Three releases tried to simplify the Studio (3.10 Simplify Constellation, 4.1
Useful by Default, 4.6 Guided Experience). Each one kept every existing
control and added a new entry flow on top: a questionnaire, a tour, a step
wizard, and a Simple/Advanced toggle that moved the same DOM controls around.
An audit on 2026-10-21 measured the result in a real browser:

- "Simple" mode laid out 311 interactive controls, 284 of them in the
  customization panel, clipped rather than removed. Opening Customize produced
  18 pairs of overlapping controls.
- Two export links rendered as empty blue bars because their text was
  invisible against the button fill.
- Opening Customize blanked the map; in the Studio the map was about 120 px
  tall on a 900 px screen.
- On-screen language required knowing engine vocabulary ("Technical Shape",
  "Ring meaning", "Seed mode", "Account sun", "Visual bridge").

`src/preview.mjs` (3,435 lines, 77 listeners) used form fields as its state
store and rebuilt configuration from the DOM on every render, so every option
needed a hand-placed control. The browser tests drove the DOM over the Chrome
DevTools protocol and asserted element state, so none of the visible failures
above failed a test.

## Decision

Replace the Studio presentation layer. Keep every engine, data and export
contract.

1. **Three surfaces.**
   - **Home**: one field (GitHub username) and one primary action. Sign-in
     and an offline example are secondary.
   - **Studio**: the map is the main element (at least 55% of a desktop
     viewport, at least 35% on a 390 px phone). One panel with four tabs:
     **Look**, **Layout**, **Projects**, **Details**. The top bar holds
     Undo, Redo, Shuffle, Save and the single primary action, **Get it**.
     Clicking a star opens a card that explains why it is there and lets
     you feature or hide it.
   - **Get it**: one dialog with five plain choices: add to a GitHub profile
     README, download an image, put it on a website, share a link, save the
     settings file.
2. **One state store.** `src/app/store.mjs` holds the account, loaded data,
   configuration options and UI state. Every configuration change goes
   through it, which gives Undo/Redo, draft autosave and render scheduling
   one place each. The DOM is never read back as state.
3. **One settings registry.** `src/app/settings.mjs` describes every
   user-facing option once: plain-language label, help text, group, control
   type, and how it reads and writes configuration. The four panels show the
   registry's essential settings; **Fine-tune** generates a searchable form
   for the rest and offers the full configuration as validated JSON.
4. **Subtraction policy.** The questionnaire, Studio tour, step wizard,
   Simple/Advanced toggle, design-code field, randomizer lock matrix, layer
   editor, comet lab, live tilt and the per-feature editors are removed from
   the interface. Their behaviour stays reachable where it is still
   meaningful: design codes still decode from share links; every option
   remains settable through Fine-tune or a configuration file; the CLI,
   Action and packages are unchanged.
5. **Budgets are tests.** Playwright journeys under `e2e/` enforce, per
   screen: no overlapping controls, no control without a visible label, no
   horizontal scroll, no banned jargon, exactly one primary action, a
   visible-control budget, a minimum map share that is not blank, axe
   WCAG 2.2 AA, and no console errors or failed requests. A new feature that
   breaks a budget fails CI.

## Why this layer?

This is presentation and orchestration, owned by JavaScript and
HTML/CSS/SVG under AGENTS.md. Nothing moves into Rust. The engine already
renders a 16-project scene in about 5 ms after warm-up, so live thumbnails of
every layout and theme are computed from the visitor's own data with the
existing `createScene` and `renderSceneSVG`.

## Alternatives considered

- **Fix the existing Studio in place.** Rejected: the failures come from
  hundreds of hand-placed controls and DOM-as-state, so each fix leaves the
  cause intact. That is what the three earlier releases did.
- **Adopt a UI framework.** Rejected: AGENTS.md and PROJECT-PRINCIPLES.md
  keep the product framework-independent, and the problem is information
  architecture, not rendering speed.
- **Keep Simple/Advanced with a better Simple.** Rejected: a mode switch asks
  every visitor to judge their own expertise first. Fine-tune is a place you
  go, not a mode you are in.

## Consequences

### Positive

- A first-time visitor reaches a full-size map in one action after typing a
  username.
- Every option has exactly one definition, so labels, help, Fine-tune and
  tests cannot drift apart.
- Visible failures (overlap, invisible text, blank map, jargon) fail CI.

### Negative / tradeoffs

- Expert controls that had bespoke editors (ring-point drag, layer ordering,
  temporal geometry drag) become Fine-tune fields or JSON.
- Browser tests that drove old Studio element ids are deleted. Their
  behavioural coverage is ported to Playwright journeys; engine, package,
  CLI and web-component tests are unchanged.
- `@playwright/test` and `@axe-core/playwright` are added as development
  dependencies. Nothing is added to the shipped runtime.

## Compatibility

- Config/schema impact: none. Configuration stays at version 7; the new UI
  writes the same option keys.
- Share links: same format and parameters; old links (including `?design=`
  codes) still open.
- Saved designs: the same `constellation-config-v1:<account>` records load
  in the new UI. The `constellation-intent-v1`, `constellation-experience-v1`
  and `constellation-studio-tour-v1` records are no longer read.
- Core API, Web Component, Action, CLI, portable embed and portfolio
  artifact: unchanged.
- Hosting: still a static `index.html` with relative paths for GitHub Pages.

## Security / trust impact

No new inputs beyond those the old Studio accepted. Configuration and
semantic-graph files keep their size limits and parsers. Tokens stay in
memory only and are never written to configuration, share links, exports or
storage. Generated content is inserted as text or as SVG produced by the
renderer, never as HTML from GitHub data.

## Testing strategy

- Node unit tests for the store and the settings registry: every registry
  write produces a configuration `parseConfig` accepts, and every essential
  setting changes the rendered SVG.
- Playwright journeys (desktop 1440×900 and phone 390×844) with stubbed
  GitHub responses for typical, tiny, large, empty, organization, unknown,
  rate-limited and offline accounts.
- axe-core on every screen state; keyboard-only completion of the core
  journey; 320 px reflow.

## Rollback strategy

The rebuild is one branch. Reverting it restores `index.html`,
`src/preview.mjs` and the old browser tests; configuration and stored designs
are compatible in both directions.
