# History & Evolution

History settings are part of the configuration (`history`). In the Studio, set them with **Fine-tune** → **Edit all settings as JSON** or by opening a settings file (**Get it** → **Save the settings file** → **Open a settings file**). Current, Historical year and Time-lapse share the same repository data; changing the year never requests GitHub data. Years span the earliest loaded public repository to the current year.

```json
{
  "history": {
    "mode": "current",
    "year": null,
    "maxHistoricalFrames": 8,
    "timeLapse": { "enabled": false, "duration": 16, "mode": "grow", "loop": true }
  },
  "contributionOrbit": {
    "enabled": false, "period": "52w", "granularity": "week",
    "style": "segments", "showCurrent": true, "animate": false
  },
  "languageEvolution": { "enabled": false, "style": "eras", "buckets": "automatic" },
  "stellarAges": { "enabled": false, "mode": "appearance", "showArchivedRemnants": true },
  "foreignGalaxies": { "enabled": false, "limit": 8, "minimumContribution": "pr", "layout": "outer" }
}
```

All features are opt-in. Existing version-1 configs continue to work. Nested settings survive config downloads, presets, share links and workflow exports; public-event snapshots are runtime data and are omitted. Flat aliases `historicalYear`, `timeLapse`, `timeLapseMode`, `timeLapseDuration`, `maxHistoricalFrames` and `languageEvolutionStyle` are also accepted. The studio writes the nested form.

## Contribution orbit

52 Monday-based UTC weeks wrap around the constellation. `segments`, `dots` and `pulse-ring` use bounded density levels from 0 to 4, based on observed public events. The small marker marks the reference week. Optional pulsing is decorative and stops for reduced motion.

This is an event-density illustration, not GitHub's exact contribution calendar or a productivity score. GitHub's [public-event API](https://docs.github.com/en/rest/activity/events) exposes at most 300 recent events, currently within 30 days. An ordinary live request cannot reconstruct a full year. Weeks outside known coverage are nearly invisible and labeled unavailable, rather than silently treated as zero. Positive observations remain visible even when a week's coverage is incomplete. Starring and forking are excluded from orbit density. A supplied normalized public snapshot can include `coverageStart` and `asOf`; without explicit coverage, empty weeks remain unknown.

The implementation shares the existing public-event source. No GraphQL calendar call, private contributions or additional credentials are needed. The CLI fetches events only if an event-driven layer is enabled; the studio reuses its existing account-load cache. History adds no per-repository calls. Rate-limit and network failures omit affected event layers, retain repository rendering and show a diagnostic. They never create synthetic live activity.

## Language evolution

`rings`, `eras` and `trails` color successive creation cohorts with the languages used by their repositories today. `timeline` additionally positions projects along a chronological spiral; explicit manual positions take precedence. Only one mode is displayed at a time. Buckets can be `yearly`, `2-year` or `automatic`; automatic chooses approximately six eras for longer histories. Short histories naturally have fewer eras.

Each repository contributes a total weight of one, split between its known languages using logarithmically bounded byte counts. A giant repository cannot dominate the account. Missing language data contributes no inferred language. Up to eight leading languages are drawn per era.

These are **inferred creation cohorts**, not exact historical language percentages or claims that a language was actively used throughout an era. An older repository's current languages may differ from those at creation. Cohorts make new language choices and their disappearance from later project cohorts visible. Deleted repositories cannot be recovered automatically.

## Stellar ages

| State | Default evidence | Appearance |
| --- | --- | --- |
| Newborn | Created less than 90 days ago | Forming halo |
| Active | Known maintenance less than 30 days ago | Bright core and glow |
| Mature | At least 365 days old, maintenance within 180 days | Stable core and calm halo |
| Quiet | Other known maintenance within 365 days | Lower opacity |
| Dormant | Known maintenance at least 365 days ago | Faint visible star |
| Archived | Explicit archive status | Hollow shell |
| Unknown | Missing or historically unavailable evidence | Neutral appearance |

Thresholds are centralized in `stellarAges.thresholds`: `newborn`, `active`, `mature`, `quiet` and `dormant`, in days. Archive status overrides other states for current views. `showArchivedRemnants: false` uses a quiet appearance instead of hiding the project. `appearance`, `halo`, `color` and `subtle` modes adjust secondary appearance. The color mode colors the halo; explicit node colors and shapes remain intact. Repository filters alone decide visibility.

Public pushes, maintenance timestamps and meaningful public events may provide maintenance evidence. Historical calculations exclude timestamps after the reference date. If today's last push is in the future relative to a snapshot, the renderer does not manufacture an earlier push or call the project dormant. Archive status in past snapshots is unknown unless an `archived_at` date is supplied.

## Foreign galaxies

Small peripheral systems show public contributions outside the target account. Owned repositories are excluded case-insensitively. The layer recognizes merged PRs, PRs, pushes, releases, issues and comments; stars and forks do not qualify. `minimumContribution` accepts `merged-pr`, `pr` (default), `code`, `issue` or `any`. `code` includes PRs, pushes and releases; `issue` also admits issues; `any` also admits comments.

Only normalized repository names, event types, dates and a merged-PR flag are retained. Private events, event bodies, actors and messages are excluded. Merged status is accepted only from an explicitly merged, closed public PR event. Repeated events are deduplicated by event ID. A bounded contribution weight controls ordering and shell size; it is not a ranking of developers. The default limit is 8, configurable from 1 to 12. Links go directly to the public repository. No decorative bridges imply unobserved relationships.

This source is recent and incomplete: absence does not mean a developer has never contributed. Repositories are not separately fetched for popularity scores.

## Historical views and time-lapse

`history.mode: "historical"` plus `history.year` includes only surviving public repositories created by the end of that year. Future dates are capped at the supplied generation/reference date. Filtering occurs before selection limits and language/topic projection, so counts and deterministic layouts are recalculated. `referenceDate` can pin an ISO date for reproducible exports; otherwise generation time is used, with existing fixture dates supported. Age sizing, activity filtering, lifecycle and language eras share that reference.

Historical metadata is limited. Today's stars, topics, repository names and language bytes are used when past values are unavailable. Deleted repositories, historical renames, exact archive dates and past popularity cannot be reconstructed from current repository metadata. These limitations are stated in the SVG and its description.

`history.mode: "time-lapse"` or `history.timeLapse.enabled: true` enables native CSS/SVG animation:

- **Grow** shares one latest-layout scene, revealing projects and their language/topic systems as they enter sampled years. Connections wait for both endpoints. Category sizes and positions use the latest scene; choose Crossfade for recalculated yearly layouts and counts.
- **Orbit** uses those same compact reveals, moving each cohort outward from a smaller radius toward its final position.
- **Crossfade** renders bounded, recalculated yearly states. Common background, card furniture and styles are shared. Current metadata limitations still apply.

Lifecycle appearance changes with the historical reference in grow/orbit, and each crossfade snapshot computes its own lifecycle. Contribution orbits and foreign galaxies use each sampled year's date, excluding future events. Current activity decorations in compact modes appear only at the latest state. Language cohorts reveal alongside project births.

Duration is 8–30 seconds (default 16); looping defaults to true. `maxHistoricalFrames` is 2–8 (default 8). Longer histories are evenly sampled, always preserving first and latest years. A crossfade above 750,000 bytes automatically falls back to compact growth, with a diagnostic in the SVG description. Dense base graphs can themselves exceed that size; the guard prevents historical scene multiplication, not arbitrary base-graph size. Turning off animation emits the latest static scene. Reduced-motion CSS shows only the latest state and year.

All output is self-contained, script-free SVG, with no external assets, fonts or `foreignObject`. Pure tests cover chronology, thresholds, coverage gaps, ownership, privacy, deterministic geometry, frame limits and size guards. Browser tests exercise the slider without additional API requests, XML parsing and reduced-motion styles.

See the [four showcase presets](../examples/README.md#history--evolution). `node scripts/generate-examples.mjs` regenerates the gallery offline from fixed synthetic fixtures. Remove fixture `referenceDate` / `activityMetricDate` values when adopting a preset for a live daily workflow.
