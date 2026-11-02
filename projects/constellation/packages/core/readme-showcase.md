# README Showcase

**GitHub activity tells Constellation what exists. You decide what represents you.**

Project roles let you give your own work a clear place in a README constellation. They describe how you want a project presented; they are not GitHub metadata and do not replace stars, activity, archive state, forks or topics.

## Project roles

- **Featured** projects act as visual anchors. Their nodes and labels receive priority, their real connections are easier to see, and their shared languages/topics can stay visible when the output is reduced.
- **Supporting** projects retain normal importance and can fill out a featured project's ecosystem.
- **Experimental** projects receive lighter emphasis.
- **Historical** projects remain present but are visually subdued.

Featured order is an explicit, bounded priority. In the Studio, **Feature it** on a star's card, or the star button beside a project in the **Projects** tab, marks it Featured and puts it after the projects already featured; press it again to remove the role. Supporting, Experimental and Historical roles, and a different featured order, are set in `projectShowcase` through **Fine-tune** → **Edit all settings as JSON** or a settings file. Dragging is never required. Recommendations help choose repositories, but never assign a role without your action. Repositories without roles keep the existing behavior.

For example, roles can be stored with a config:

```json
{
  "projectShowcase": {
    "owner/sprout": { "role": "featured", "priority": 1 },
    "owner/kitchen-inventory": { "role": "supporting" },
    "owner/old-prototype": { "role": "historical" }
  }
}
```

Roles and priority are account/repository scoped and survive config export/import, share links, workflow generation and daily regeneration. If a repository becomes private, disappears or is unavailable, it is skipped and reported; its saved role remains so it can return with the project. **Shuffle** preserves roles and featured ordering.

## README presentation

Set `readmePresentation` to `recruiter`, `full-universe`, `featured-work`, `current-focus`, `technology-identity` or `project-journey` (in **Edit all settings as JSON** or a settings file). These modes derive a view from the same selected projects, roles and visual settings.

- **Recruiter · project orrery** makes the exported SVG the complete artifact. See the encodings and evidence limits below.
- **Full universe** keeps the broad selected graph and gives Featured projects extra emphasis.
- **Featured work** focuses on Featured and Supporting projects when those roles are available; their real language/topic relationships remain the source of connections.
- **Current focus** orders projects using a supplied public activity snapshot. Without one, it keeps the existing order and explains that activity data is missing. It never invents recency.
- **Technology identity** uses the existing combined project/language/topic graph to show real membership around Featured work.
- **Project journey** gives Featured and Historical roles context from available creation dates and configured historical data. It does not create historical star counts or dates.

## Rings and treatment

`ringOrganization` supports `identity` (automatic), `importance`, `activity` and `manual`. Project importance assigns available identity-ring anchors to Featured, Supporting, Experimental and Historical projects in that order. Ring capacities remain deterministic; projects that do not fit their preferred ring use remaining anchors. Saved manual node coordinates are not changed when switching modes.

**Featured projects stand out with** (in **Fine-tune**) offers A bold name, A bigger star and A spotlight (`featuredTreatment`). Spotlights show bounded repository description and technology text, escape all metadata, and show at most three well-spaced projects. Crowded and small outputs fall back to stars and labels.

## Output profiles

Choose one with **Image shape** in **Fine-tune** (`exportProfile`).

- **Hero:** 900 × 560 for the full composition.
- **Wide README:** 900 × 320 with reduced label and background density.
- **Compact:** 900 × 180, retaining higher-priority labels and reducing background decoration.
- **Square:** 480 × 480 for documentation and side-by-side layouts.

Profiles change composition budgets, not the saved project selection. A smaller export can omit lower-priority labels without removing roles or repositories from your config. Reduced motion and current SVG/HTML accessibility behavior continue to apply.

### Dense grouped exports

Use the **Profile README** image shape with grouped detail (**Group related projects**) for compact maps of larger project sets. Static README output with at least 30 visible projects chooses Groups when groups exist; an explicit Projects export remains respected. Group size reflects member count within a bounded visual range. Aggregate edge visual weight reflects the number of represented source relationships, not dependency strength or project importance. Dense static exports prioritize semantic group and user-curated labels; hidden visual labels remain represented in accessible scene descriptions. SVG is the canonical static image, and PNG export rasterizes that same SVG. Offline HTML and Web Component views retain interactive Semantic Zoom and the full group evidence inspector.

## Recruiter project orrery

Set `"readmePresentation": "recruiter"`. The simplified 3.9.x presentation uses a fixed 1200 × 840 canvas, scalable to README widths of 800–1200 pixels. Themes and animation preferences remain available. Manual positioning, category graphs, perspective, decorative motion and profile scores do not apply here. Other presentations retain their settings.

### Visual recruiter presentation

The center shows display name (when available), username, up to three primary languages and up to three recurring repository topics. Topics must occur in at least two displayed projects; duplicate tags within a repository and generic tags such as `github`, `readme` and `portfolio` are excluded. Missing or noisy topics are omitted; no professional roles are inferred.

| Visual | Meaning |
| --- | --- |
| Planet size | Developer-curated importance: Featured largest, Supporting medium, Experimental/Historical small; unassigned projects use a conservative default. This reflects user curation, never automated quality scoring, skill, stars or active-month counts. |
| Distance | Latest non-future repository push or observed work event. NOW: under 30 days; RECENT: under 183 days; EARLIER: older. Unknown dates are placed outside with a caveat in the project title. Repository activity is not necessarily the developer's own activity. |
| Color and language counts | Primary repository language; counts cover displayed projects, not skill levels. |
| Featured labels | Up to three lines: name, primary language, and other loaded contributors when known and positive (excluding the profile owner). Partial contributor counts retain `+`. Confirmed external participation adds a secondary `contributed` marker beside the language. Other projects have name-only labels. |
| Quiet connection | Explicitly curated pair in `projectRelationships`; never inferred from shared languages or topics. |

Projects respect existing selection and filters, capped at seven (or a lower `maxRepos`), prioritized by authored roles/order then repository push recency. Aim to curate 2–4 Featured, 2–3 Supporting and optionally one Experimental/Historical project. Roles are never assigned automatically. Other loaded public repositories are counted separately, including those outside current filters; this is not an account-wide total when discovery is partial. Long labels are truncated with full identity and repository names in accessible titles.

Existing 3.9 configurations remain valid, but Recruiter exports now show fewer projects, use role-based size and three recency bands, and have a shorter canvas. No new settings are required. Moons, quarterly arcs, hollow unknown-history planets and per-project history rows are removed from the visual presentation. Only the slow recent Featured outline animates; reduced motion and static exports preserve all essential information.

### Underlying evidence

Loaded active months, complete-history quarters, partial-scan flags and verified participation remain available internally. Project titles retain active-month lower bounds, unknown history/contributors/recency, and external ownership versus confirmed participation caveats. Missing history does not alter a project's size or fill. Missing contributor scans never establish solo work. The compact key explains size, distance and color, plus a relationship line only when present.

Add related pairs in Showcase, one `owner/repo ↔ owner/repo` per line, up to six. Both endpoints must be displayed for a connection to appear. Example config fields:

```json
{
  "readmePresentation": "recruiter",
  "projectShowcase": {
    "alice/atlas": { "role": "featured", "priority": 1 },
    "alice/atlas-mobile": { "role": "supporting" }
  },
  "projectRelationships": [["alice/atlas", "alice/atlas-mobile"]]
}
```

The renderer reuses `historyData`, `commitHistoryData`, `commitFieldData` and `organizationData` snapshots already supplied by the application or API. Selecting the presentation performs no network enrichment. Public metadata alone cannot establish sustained history or contributor counts. Authenticated activity/commit/contributor loading remains explicit in the existing Studio controls. Config/share links preserve curation, not runtime snapshots: another device or a daily workflow must reload evidence. GitHub's recent event feed and capped commit samples cannot establish lifetime continuity; absent periods in these samples are never rendered as inactivity gaps. Counts describe observed repository work, not a measure of personal effort or quality.

[Example SVG](../examples/recruiter.svg) uses explicitly synthetic offline test data. Browser regressions save normal, static and key-hidden previews under `.cache/recruiter/` at 800, 1000 and 1200 pixels. Visual regressions check label bounds, identity, static readability and reduced motion. Repository recency remains distinct from individual work.
