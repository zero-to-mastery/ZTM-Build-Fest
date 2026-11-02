# Reproducible README designs

This guide covers configuration: the settings file, the CLI, the Action, share links and what each option does. For the Studio itself, read the [Studio guide](studio.md); for what rings, size and colour mean, read [Reading a constellation](semantic-studio.md).

The Studio configures a self-contained SVG. It needs no account system, external fonts, JavaScript inside the exported image, or hosted database. The CLI and Action use the same rendering options as the Studio.

## In the Studio

Every option in this guide is set in one of three places in the Studio:

- the four tabs, **Look**, **Layout**, **Projects** and **Details**, which hold the most useful settings;
- **Fine-tune every setting**, which lists every registry setting with search;
- **Fine-tune** → **Edit all settings as JSON**, or **Get it** → **Save the settings file** / **Open a settings file**, for options with no control of their own.

The settings registry (`src/app/settings.mjs`) maps each on-screen label to its configuration key. Changing a setting never fetches data.

## README Showcase

Project roles are product intent, separate from colour and geometry. **Feature it** on a star card, or the star button in the **Projects** tab, marks a project Featured; other roles and featured order are set in `projectShowcase`. **Shuffle** preserves roles and their order. Daily generation keeps entries for temporarily missing projects and reports when a role cannot be rendered.

See [README Showcase](readme-showcase.md) for role semantics, presentation modes, semantic rings, spotlight limits and the coordinated output profiles.

## Shuffle and design codes

**Shuffle** in the Studio draws a random look and layout (styling, layout and connections) from the design randomizer and keeps your projects and roles. **Undo** brings the previous design back. A shuffled design is stored as explicit settings, so a share link, saved design or settings file reproduces it exactly.

Older versions of the Studio showed a design code such as `v5:m008-y2026-f2012-my-sky`. The Studio no longer has a field for codes, but they still decode: a share link with `?design=` opens the same recipe. For example, `v5:m008-y2026-f2012-my-sky` permits only the second ring to animate and draws historical years from 2012–2026. The code stores the loaded account's year range, so replay does not drift into new random years as time passes. Existing `v1`–`v6` recipes are frozen and remain supported.

Account identity, repository source, credentials, timezone, authored text and GitHub facts are not randomized. Customization and randomization never fetch GitHub data.

Explicit `nodeColors` override automatic color mappings. Remove them to return to a mapped palette.

## Visual mappings

### Background starfield

**Background** in the **Look** tab offers Plain, Stars, Deep space and Milky Way (`starfield.mode`). The generator creates up to 500 decorative stars with three apparent depth layers, small size/brightness differences, faint warm/cool tones and occasional brighter points. Milky Way concentrates stars around a curved band with faint haze. These remain behind the graph, do not receive focus or pointer events, and never count toward repository/node limits. Pair with a dark theme to get a space backdrop.

`starfield` accepts `mode` (`off`, `classic`, `space`, `milky-way`), `density` (0–100), `brightness` (0–1), `depth` (0–1), `twinkle` (boolean), and `seed` (up to 120 characters). An empty background seed follows the design seed; set `starfield.seed` to change only the background. Increasing density extends a stable point sequence without moving existing stars. Compact output profiles reduce the decorative point budget.

Only a sparse subset twinkles, using CSS animation. Turning off **Twinkling stars** (in **Fine-tune**), setting `starfield.twinkle` to false, or requesting reduced motion produces a still sky. No JavaScript animation loop is added. Transparent exports retain stars but omit the band haze. Existing configs without `starfield` retain classic dust; a fresh Studio design starts with Deep Space stars, and `v2:`–`v5:` randomized designs save their own sky settings. **Background star amount** and **Background star brightness** in **Fine-tune** set `starfield.density` and `starfield.brightness`.

### Nodes and connections

`nodeSize` accepts `uniform`, `stars`, `activity`, `age`, `languages`, `topics`, or `membership`. Missing settings retain `legacy` sizing. Categories use bounded membership sizing for data-driven modes. Repository star and count metrics use logarithmic bounds; radii remain between 2.7 and 6 SVG units.

`nodeColorMode` accepts `custom`, `language`, `seeded`, `category`, or `contribution`. Contribution-style color measures repository recency, **not** the GitHub contribution calendar. Known languages use recognizable colors; other languages have deterministic fallback colors. Explicit `nodeColors` always win.

`nodeGlowMode` accepts `uniform`, `stars`, `activity`, or `seeded`. `connectionWeight` accepts `uniform`, `languages`, `topics`, or `overlap`; it changes width and opacity without increasing the number of graph connections.

Activity and age use the newest public repository update in the included data as a stable reference. Set `metricDate` to an ISO date to freeze another reference date. Missing dates get the smallest activity/age value. Relative repository filters (`updatedWithin`) intentionally use the current date.

## Themes and layouts

Pick a theme from **Theme** in the **Look** tab; each card is a preview of your own map. Built-in themes include Deep Space (the default, listed first), Adaptive (`mnix`: see-through, follows light or dark mode), GitHub Dark, Terminal Green, Solarized, Dracula, Synthwave, Monochrome, Contribution Graph, Rustacean, and JavaScript Yellow. They coordinate palettes, glow, secondary line opacity and selected shape/animation defaults. Applying a theme leaves project filters, placements, ring rotations and manual colors intact. Visual controls remain editable afterward. Configs can set `theme` to a preset name or use `visualTheme` alongside the existing `auto`, `light`, and `midnight` modes. Explicit config values override preset defaults. Try `"theme": "sudo"` for a small terminal easter egg.

**Galaxy** groups primary languages into distinct clusters. **Solar System** selects up to four major nodes by stars or recent update (`majorMetric: "stars"` or `"updated"`) and positions related nodes around them. Ties use repository names. These arrangements feed deterministic positions into the existing Rust scene engine; manual coordinates override them. Existing field, orbital, force and ring arrangements remain available.

**Orbit shape** (`orbitShape`) sets how orbit-based layouts (Rings, Galaxy, Solar system, Orbits, Scatter, and ring-meaning bands) use the canvas. `"wide"` is the engine default: orbits reach about twice as far sideways as up and down, so a map fills a wide README banner. `"round"` draws true circles, centred, with space either side on a wide canvas. Configurations without `orbitShape` render exactly as before. New designs made in the Studio start round. Organization layouts and the 3D time views keep their own geometry.

Ring points now spread across all four rings before a ring receives another point. Adding nodes retains existing point coordinates. Hidden nodes still reserve their own points so hiding a node does not rearrange the chart.

Optional `nodeShape` values are `circle`, `star`, `diamond`, `hexagon`, `square`, and `mixed`. Shapes use shared SVG clip definitions and retain the existing animated circle anchors. `effect` offers `none`, `grid`, `scanlines`, or `coordinates` (small hexadecimal IDs). Effects are static, lightweight decorations. `legend: true` adds a compact explanation of the selected visual mappings. Reduced-motion behavior remains active.

### Refine layout

**Tidy overlapping stars** in **Fine-tune** (with **Tidy strength**) enables a one-shot Rust/WASM overlap-reduction pass after the selected arrangement. It is off by default. Intensity ranges from 0–10 (default 5); zero is a no-op, and higher values allow more iterations and up to `6 × intensity` SVG units of movement from each starting position. The pass uses node and estimated label bounds, preserves node-to-label attachment, and does not hide additional labels. Crowded layouts can still overlap.

Tab reaches interactive nodes. Enter or Space selects a node; Shift with either key selects a path endpoint, and Escape clears selection. Focus has an outline even with glow disabled. Omitted labels are reported as diagnostics with node IDs and reasons (`no-collision-free-position` or `export-profile-limit`). Programmatic rendering accepts `{ onDiagnostic }` as its fourth argument; diagnostic callbacks do not alter the SVG.

Refinement does not guarantee that every collision is removed or that every label fits. With snapping enabled, fixed and hidden pairs reserve their ring points even if manually placed off-ring. Movable pairs can swap points only when both moves satisfy their bounds and movement limits; a pair with no improving valid move stays in place. Dragging stars in the Studio is separate from automatic refinement.

```json
"layoutRefinement": { "enabled": true, "intensity": 5 }
```

Manual node positions, manual label positions/offsets, and hidden nodes/labels pin their entire pair. Other nodes can move around them. Saved manual placements are protected. Choosing a different layout clears manual placements, so those pairs participate again.

With **Line stars up on the rings** (`snapToRings`) enabled, accepted moves land on valid ring anchors and can swap two movable pairs. Hidden nodes reserve their points. Bounds and intensity still apply, so occupied rings or distant anchors can prevent improvement; unchanged off-ring starting positions are retained rather than forced onto distant anchors. Turn snapping off for free nudges that stay near the starting arrangement.

Refinement is deterministic for the same repository data and settings and is independent of motion or reduced-motion preferences. The browser, CLI and Action call the same WASM function. SVG contains the resulting coordinates; configurations, workflows, saved presets and share links retain the setting and manual coordinates so the result is recomputed from the same inputs. Live GitHub data can change future output. This is an additive config field; existing `v1`–`v5` recipes are unchanged and no new recipe version is required. Randomizing styling or animations preserves this setting.

## Choose repositories

The **Projects** tab lists the loaded account's projects with a search box. Tick or untick a project to put it on the map or take it off; the first change switches from automatic picking to your own list. **Choose automatically** removes your list and goes back to the current filters and **Most projects to show**. **Hide it** on a star card also takes a project off the map. Only public repositories loaded for the current account are listed.

An explicit selection is stored as `includeRepos` and survives saved designs, settings files, share links and workflow exports.

## Built-in account presets

**Chingu** and **Code the Dream** are available under **Theme** in the **Look** tab for any account or layout. Chingu uses the emerald and mint colors from [chingu.io](https://www.chingu.io/). Code the Dream uses the navy, coral and yellow from its [brand standards](https://codethedream.org/logo/), with a darker coral for contrast on light backgrounds. Both have transparent backgrounds and include light and dark palettes. Use `visualTheme: "chingu"` or `visualTheme: "code-the-dream"` in configuration, or `theme=chingu` / `theme=code-the-dream` in a share URL. Saved configurations and theme packs retain these selections.

Built-in presets (Project map, Flagship projects, Technology atlas, Language orbits, Recent work, Project journey, Minimal README, Classic Constellation, and the organization presets) are applied with the `preset` share-link parameter. The Studio has no preset menu; **Theme**, **Pick a layout** and **Shuffle** replace it.

Your personal branch palette is available as **Adaptive** under **Theme** in the **Look** tab. It has a transparent background and automatically switches between your original light and dark palettes using the viewer's color preference. Apply it to any layout, or set `visualTheme: "mnix"` in configuration / `theme=mnix` in a share URL. The **Classic Constellation** preset combines this theme with identity rings. Themes are preserved in saved configurations and share links.

Recent work selects recently updated repositories; its lifecycle halos use repository metadata. Project journey infers language eras from surviving projects' creation dates rather than historical snapshots. These presets do not require a contributor scan.

## Portable config and local drafts

The Studio saves a draft of the current design in `localStorage` as you work, separately from the `sessionStorage` GitHub cache, and restores it when you open the same account again. **Save** keeps named designs for an account in the same browser. **Get it** → **Save the settings file** downloads the design as JSON, and **Open a settings file** loads one. **Fine-tune** → **Edit all settings as JSON** shows and applies the same JSON. Storage failures leave the Studio usable and point to the settings file instead. Deleting a saved design does not delete a downloaded file.

New files have `version: 1` and ordinary human-readable render options. An optional `account` identifies the studio account; the Action still uses its configured username or repository owner. Old unversioned Action/config payloads continue to work. Imports validate nested values, reject prototype keys, future versions and files over 250 KB, and exclude tokens, caches and unknown runtime fields. Imported CSS must be self-contained: no imports, external URLs, CSS escapes or expressions. Existing trusted unversioned CLI CSS behavior is retained.

## URL parameters and sharing

In the Studio, press **Get it** → **Share a link**, then **Copy link**. Links include account, filters, mappings, palettes, seed, node colors, visibility, ring settings, manual coordinates, label offsets, and authored CSS. Tokens and runtime API data are excluded. Localhost previews generate links to the public Studio. A design too large for a link (over 8,000 characters) is refused with a message offering **Save the settings file instead**, rather than silently dropping edits.

Opening a valid link takes precedence over a saved local draft. Sharing fetches current public repository data, not a frozen API snapshot; use the SVG download to keep the generated image unchanged. Pins require sign-in.

Readable links work without an encoded configuration:

```text
https://mnichols08.github.io/constellation/?user=octocat&preset=project-map&maxRepos=25
https://mnichols08.github.io/constellation/?organization=github&preset=organization-community
https://mnichols08.github.io/constellation/?user=USERNAME&organization=ORGANIZATION
https://mnichols08.github.io/constellation/?user=octocat&design=v5:m008-y2026-f2012-my-sky
```

| Parameter | Meaning |
| --- | --- |
| `user` | GitHub account to load; with `organization`, the person to highlight |
| `organization` | Organization to load; works without a user |
| `accountType` | `auto`, `user`, or `organization` for the account in `user` |
| `organizationUser` | Optional person to highlight when `user` is the organization account |
| `preset` | `project-map`, `classic-constellation`, `flagship-projects`, `technology-atlas`, `language-orbits`, `recent-work`, `project-journey`, `minimal-readme`, `organization-projects`, `organization-featured`, `organization-community`, `organization-technology`, or `organization-history` |
| `design` | Reproducible `v1`–`v6` design code |
| `theme`, `visualTheme` | Color mode (`auto`, `light`, `midnight`) or named visual theme such as `deep-space` or `terminal` |
| `arrangement`, `layout` | Arrangement such as `galaxy` or `solar-system`; format `atlas` or `compact` |
| `nodeMode`, `nodeSize`, `nodeColorMode` | The same node and mapping values used by configuration JSON |
| `maxRepos`, `minStars`, `sortBy`, `repoQuery` | Project limit, minimum stars, selection order, and name filter |
| `animate`, `includeForks`, `includeArchived`, `codingRhythm` | `true`/`false` or `1`/`0` |
| `seed`, `seedMode` | Layout seed; supplying `seed` alone selects custom seed mode |
| `organizationScope`, `organizationView` | Organization selection and view settings |
| `repoSource` | `all` or `pinned` |
| `codingRhythmTimezone`, `historicalYear` | IANA timezone or historical year |
| `view` | Encoded complete configuration written by **Share a link**; existing links remain supported |

Settings are applied in this order: encoded `view`, optional `preset`, optional `design`, then explicit parameter overrides. A theme override replaces saved palettes; custom CSS can still override styling. Generated links expose common settings beside `view` so you can edit them directly. A `view` must match its account parameter. Duplicate or invalid recognized parameters produce an error instead of loading a different design. Use URL encoding for spaces, `#` characters, and other special characters in parameter values.

## Output profiles and file size

Profiles use the same SVG renderer:

| Profile | Dimensions | Labels and decoration |
| --- | --- | --- |
| Hero | 900 × 560 | Full scene, full label budget |
| Wide README | 900 × 320 | Reduced label and background density |
| Compact | 900 × 180 | Featured-first labels, minimal background; spotlights fall back to labels |
| Square | 480 × 480 | Full square export canvas |
| Transparent | Current layout dimensions | No background or nebula |

All profiles keep attribution and existing collision-aware labels. PNG download uses browser SVG → Image → Canvas at 2×–3× resolution; it captures a static frame and does not replace animated SVG. If the browser cannot rasterize the SVG, SVG download remains available. Static example fixtures are tested under 250 KiB for 24 repositories; dense graphs and native motion can be substantially larger. Balanced connections, fewer labels, and disabled motion keep README payloads smaller.

## Multiple images

Use separate config files and output paths; no dashboard is needed:

```yaml
- uses: mnichols08/constellation@v1
  with:
    config: examples/deep-space.json
    output: constellation-all.svg
- uses: mnichols08/constellation@v1
  with:
    config: constellation-rust.json
    output: constellation-rust.svg
```

For the Rust image, include `"languages": ["Rust"]` in its config. Use a revision containing these features until they are included in the published Action version. Existing `publish: true` preserves other files in the output branch.

## Tests

Run `npm test` and `npm run test:rust`. `npm test` covers the configuration parser, settings registry, store, renderer, CLI and packages; browser tests for exports and the component run when Chrome/Chromium is found (or set `CONSTELLATION_BROWSER` to its executable). `npx playwright test` drives the Studio itself: settings files, saved designs, drafts, share links, keyboard use and PNG download, all with stubbed GitHub responses. Run `npm run build:rust` after Rust changes and include the generated `src/wasm` assets.

## Recent public activity

**Highlight recent activity** in **Fine-tune** (sign-in required) offers Off, Glow, Pulse, Comet and Ripple. The default is Off. Activity augments existing glow and follows node colors and motion without changing size, repository selection or graph placement. Category-only views have no repository activity accents. Reduced motion leaves a static halo, faint comet trail or ring. Starlight animation off also makes activity effects still.

| Config field | Values / default |
| --- | --- |
| `activityEffect` | `off` (default), `glow`, `pulse`, `comet`, `ripple` |
| `activityWindow` | `1d`, `7d` (default), `30d`, `auto` |
| `activityDetail` | `simple` (default), `event-types` (PR double rings; release/new-repository accents) |
| `activityConnections` | `false` (default); true subtly brightens relevant lines |
| `activityMetricDate` | Optional reference date for fixed examples/tests |

Settings work in JSON, CLI, Action config, saved designs and share links. Fetched events and calculated scores are excluded from these exports. Live repository and event data can change the generated image. Save the settings file to preserve activity settings and other manual changes.

The loader requests `/users/{username}/events/public` centrally, at most three pages of 100 events. The studio caches a normalized snapshot per account for the tab session. Only account load/refresh fetches data; changing modes, colors, themes or windows uses that snapshot. The CLI skips events entirely when both recent activity and Coding Rhythm are off. Fetch failures remain nonfatal and produce a diagnostic. Only public events matching represented public repositories influence rendering; payloads, commit messages, issue/PR text and actors never enter the activity cache or SVG.

Scores use a 72-hour half-life within the selected window. Weights are push 1, pull request 1.2, release 1.5, repository/branch creation 1.25, issue .4, comment .2, watch .1 and fork .25. Each event type contributes at most 6 weighted points per repository, total mass is capped at 12, and score is `min(.98, 1 - exp(-mass / 3))`. Auto uses the shortest supported window containing a matching event; no activity falls back to 30 days. These limits keep busy projects from overwhelming the image.

This is a daily README visualization, not real-time telemetry or a contribution counter. GitHub's [public events API](https://docs.github.com/en/rest/activity/events#list-public-events-for-a-user) can be delayed and returns a limited history. Missing events do not prove inactivity.

[Active Developer](../examples/active-developer.json) combines Deep Space, Galaxy placement, star-based size, language color and comet trails. Its [synthetic event fixture](../examples/fixtures/public-events.json) and fixed reference date reproduce the gallery without network access. Run `node scripts/generate-examples.mjs`. For CLI fixtures, combine `--fixture repositories.json --activity-fixture events.json`; omitting the event fixture with repository fixtures keeps generation offline. Remove `activityMetricDate` when adapting the example to a live daily workflow.


## Coding Rhythm / Circadian Sky

**Show when you usually code** in **Fine-tune** (sign-in required) turns this on; `codingRhythmStyle` chooses Orbit, Active arc or Halo. The outer orbit shows when recent public GitHub activity commonly occurs; brighter regions indicate more common active hours. Weekday stars run Monday-Sunday. The feature is off by default, including when changing themes. It uses theme colors and preserves repository positions and identity rings.

This uses only available public events, reusing the existing snapshot without additional requests. Event history may be incomplete (at most 300 available events). It is not a full contribution history, exact coding time, productivity measurement, or private activity tracking. The rhythm covers the account's public events, including projects outside the displayed selection; repository accents still follow represented projects.

| Config field | Values / default |
| --- | --- |
| `codingRhythm` | `false`; set `true` to enable |
| `codingRhythmStyle` | `orbit` (default), `active-arc`, `halo`, `hidden` |
| `codingRhythmWindow` | `7d`, `14d`, `30d` (default); independent of comet settings |
| `codingRhythmTimezone` | `UTC` (default), or an IANA zone such as `America/New_York` |
| `codingRhythmDays` | `off`, `subtle` (default), `full` (weekday initials) |
| `codingRhythmAnimate` | `false` (default); decorative SVG orbit marker |
| `codingRhythmPeakLabel` | `true` (default); shown only with sufficient events |
| `codingRhythmLabels` | `none`, `quarters` (default: 00/06/12/18), `cardinal` |
| `codingRhythmCelestialMarkers` | `false`; faint clock-day/night arcs, not sunrise/sunset |
| `codingRhythmProjectHints` | `false`; tiny static repository halo intensity differences based on activity hour |

Headless `local` deterministically resolves to UTC; it never uses the runner's timezone. No geolocation is stored. Intl handles timezone and DST conversion. A repeated local hour on a fall-back day shares one saturated bucket.

Weights are push 1, pull request .9, release .8, create .7, issue .35 and comment .15; other events contribute zero. Each local date/hour bucket contributes `1 - exp(-sum(weights))`. Hourly and weekday distributions are independently normalized to [0, 1]. Five events in five occupied buckets are required to describe a peak; fewer events produce subdued marks, and no relevant events omit the layer. The peak window is the strongest four consecutive hours, including midnight wrapping; ties choose the earliest start hour. Confidence is a coarse coverage indicator, not statistical certainty.

Animation is decorative, not the current time. Reduced motion hides the traveling marker and leaves the static orbit unchanged. Theme colors work in adaptive light/dark and transparent exports. Configuration, saved designs, share links and daily Action workflows preserve settings without storing events or aggregates.

[Night Owl](../examples/night-owl.json) combines Deep Space, Galaxy, comet trails and a 30-day New York orbit. [Weekend Builder](../examples/weekend-builder.json) demonstrates weekday stars and an active arc. Both have fixed synthetic public-event fixtures and [gallery SVGs](../examples/gallery/night-owl.svg). Run `node scripts/generate-examples.mjs` offline; it reports total size and rhythm overhead (about 4.1 KiB orbit / 1.8 KiB active arc). Remove `activityMetricDate` when adapting either preset to a daily live workflow. This shared reference date freezes fixture aggregation; ordinary generation uses the snapshot date.

## History & Evolution

Contribution orbits, inferred language eras, stellar ages, foreign galaxies and historical growth share a public-only temporal model. History settings live in configuration (`history`); set them with **Edit all settings as JSON** or a settings file. See the [history guide](history.md) for configuration, data limitations, API behavior and time-lapse size safeguards, or explore the [four showcase presets](../examples/README.md#history--evolution).

## First visit

The Studio opens on Home unless the address says otherwise: `?user=NAME` opens that account's Studio with its draft, and a share link opens its own design. Home remembers the last username in this browser. See the [Studio guide](studio.md#home).

### Temporal recipes (v6)

Full Random chooses Temporal Universe in 28% of eligible seeded draws. It favors
stack, cylinder, sphere and dome over cone, hourglass and helix. Geometry and
camera values use curated ranges rather than independent full-range sliders.
At least six repositories and three distinct creation years are required, or
three useful observed snapshot/current years within the most recent 20 years.
Missing history falls back to an ordinary design. Retrospective slices describe
known existence using current metadata, never invented historical metrics.

A code such as `v6:mfff-y2026-f2015-e1-fixture-38` records the motion permissions,
reference year, first year and eligibility (`e1`; `e0` means ordinary only).
The same code and source/configuration replay the same choices. The recipe pins
its reference date to the end of that code's reference year. The v5 generator,
its 12-bit mask and all released v1�v5 recipe outputs remain unchanged. Config
schema version 7 is separate from design-code version 6; no config migration is
needed. Old codes remain directly importable.

Full Random preserves explicit semantic `ringPlacements` when selecting temporal
geometry. Partial styling/animation draws retain the temporal form and placements.
Because manual placements and snapshot data are external to a design code, save
JSON or a share link to reproduce those inputs as well. Source eligibility is
rechecked when a share link restores a temporal code on a different account.

Run `node scripts/preview-temporal-random.mjs` for the six reproducible fixtures
and a screenshot gallery in `.dist/temporal-random/`. Their recipe hashes are
locked in `test/fixtures/randomizer-v6.json`.
