# Organization universes

Choose **Organization** beside the account field, enter an organization such as `chingu-voyages`, and click **Build constellation**. No username is needed. New organization views start with a representative project atlas, language colors, and contributor discovery off. An existing organization-only draft is restored when available. Switching from a user-focused view clears that user's highlighting. The **Account** option still detects users and organizations automatically.

Open **Choose a preset** above the preview for a useful starting point:

| Preset | Shows | Contributor discovery |
| --- | --- | --- |
| Project atlas | Representative projects grouped by language | Off |
| Flagship projects | Up to 25 popular projects in a solar system | Off |
| Community | Projects and their public contributors | Up to 20 repositories, 15 contributors each |
| Technology map | Languages shared across projects | Off |
| Project eras | Surviving projects grouped by creation year | Off |

Applying an organization preset loads the data it needs, reusing cached results. Each preset replaces visual settings and filters, including random design codes, hidden nodes, and manual positions; save the design first (**Save**, or **Get it** → **Save the settings file**) to keep an edited one. Choose **Adaptive** under **Theme** in the **Look** tab to apply the personal branch palette to any preset. Account identity and any deliberately selected user focus are preserved. The [account presets](designs.md#built-in-account-presets) are also available; these switch to the project view while keeping the organization identity. Presets can be customized, saved locally, exported as JSON, shared, or used in the daily workflow.

Personal **Galaxy** and organization **Community galaxy** share their project placement. With the same projects, seed, and language grouping, project stars occupy the same positions. Adding technology or contributor nodes keeps those project anchors and places the additional nodes near their connected projects. Shared languages and topics retain their colors across account types, and node sizing and connection styling use the same controls. Project labels take priority in dense views. Contributor discovery no longer hides projects outside the scanned subset.

The Community preset adds people to the same project atlas and retains its project limit and size mapping. Explicit year/prefix/topic grouping, Era rings, Collaboration gravity, and a focused user view still provide different arrangements when wanted. Manual positions continue to override generated placement.

The suggested output repository for an organization is `ORGANIZATION/.github`; an explicitly chosen output repository is preserved. Use the generated snippet in the organization's profile README and install the workflow in the repository shown in **Get it** → **Add it to your GitHub profile**.

To map a person into an organization, choose **User in organization**, enter the **username in the first field** and the **organization in the second field**. Contributor diamonds, their projects, and contributors sharing those projects are highlighted. The organization remains the generated account; `organizationUser` records the highlighted username. Absence from a bounded scan is never presented as proof of no contributions.

Paired lookups first search public pull requests authored by that username in the organization, independently of the recent/representative repository window. Up to five search pages and 20 verified public project metadata records are cached. Those projects are prioritized for contributor discovery and rendering. Authored pull requests establish participation even when the author is absent from the top contributor page; their counts remain separate from repository contribution totals. Failed or truncated searches report partial coverage.

In community/gravity layouts, the selected user occupies the center, their projects form the inner orbit, and collaborators/technologies form the outer orbit. Thick bright spokes identify direct participation; unrelated context recedes. The SVG includes an explicit username → organization heading and a connected-project count.

```json
{
  "accountType": "organization",
  "organizationUser": "YOUR_USERNAME",
  "organizationScope": "sample",
  "organizationView": "collaboration",
  "arrangement": "community-galaxy",
  "maxRepos": 100,
  "organization": {
    "contributors": {
      "enabled": true,
      "strategy": "representative",
      "maxRepositories": 100,
      "maxContributorsPerRepo": 25
    },
    "grouping": {
      "mode": "regex",
      "pattern": "^v(?<voyage>\\d+)-(?<tier>tier\\d+)-"
    }
  }
}
```

Generate with `node src/cli.mjs --username chingu-voyages --config constellation.config.json`. A local `GH_TOKEN` or `GITHUB_TOKEN` increases available public API requests. No administrator access or organization membership list is used. Exported organization workflows set the target organization explicitly, even when installed in a user's repository.

## Scope and cost

| Scope | Direct project selection | Metadata budget |
| --- | --- | --- |
| `active` (default) | Most recently pushed | Up to 3 pages / 300 repos |
| `recent` | Most recently updated in the discovered pool | Up to 3 pages / 300 repos |
| `featured` | Known pins, then stars | Up to 3 pages / 300 repos |
| `sample` | Deterministic year, language, naming-family buckets | Up to 3 pages / 300 repos |
| `all-metadata` | Representative sample of all discovered projects | Up to 1,000 pages / 100,000 repos |

Metadata completeness is reported separately from contributor coverage. Ordinary scopes deliberately sample a bounded discovery window. `all-metadata` continues cached pagination; reaching a budget or rate limit leaves an explicit partial result. The featured fallback ranks the discovered pool; pins supplied by the existing pinned-source pipeline are respected.

Contributor discovery defaults to `representative`: one bounded request per selected repository, up to 100 repositories and 25 contributors each. `featured` and `active` change the scan selection; `off` disables it. `deep` is explicit, displays an API-cost notice, and permits up to 2,000 repositories, still respecting the configured limit. Per-repository results are capped at 100. Three concurrent requests maximum; rate limits stop new scheduling and successful results survive. Anonymous contributor records are excluded rather than converted into invented identities. Contributor totals remain **selected-scope totals**, including in deep mode.

The studio persists public metadata and contributor results in optional browser storage. The CLI uses `.cache/constellation-organization.json`; preserve this file between runs for reuse. In ephemeral CI, cache `.cache/` if reuse is desired. The CLI accepts `--refresh-data` to update cached metadata and contributor snapshots. No tokens are stored in the cache, configs, or SVG.

## Visuals and limits

Views: `projects`, `community`, `collaboration`, `technology`, `history`. Additional Nodes Represent choices: Contributors, Full ecosystem, Organization community, Dependencies. Community/collaboration project selection prioritizes repositories with scanned contributors; a focused user's known projects take priority within the current filters.

At most 100 repository nodes, 120 contributor nodes, 60 category/era nodes, **256 total nodes**, and 2,048 organization edges. Omitted projects are grouped into era systems where category space permits; remaining omissions are reported. Aggregate inspector lists show at most 100 names while tooltips retain represented counts. README SVGs use native geometry, with diamonds for contributors and hexagons for supplied dependencies—no avatar images or runtime JavaScript.

`community-galaxy` clusters projects by family and places contributors near their projects. `collaboration-gravity` settles a sparse spring graph once with spatially bounded repulsion. `era-rings` places groups on concentric rings. Existing Rust/WASM scene generation and export controls remain shared with developer universes. Contributor-only/category views use bounded neighbor chains through shared projects, not every possible pair; line strength increases with shared-project count, capped at four.

Grouping: `auto` (year + prefix), `year`, `prefix`, `topic`, `language`, `regex`, `none`. Named captures become grouping metadata. Patterns support a restricted anchored syntax with simple captures and literal delimiters; nested quantifiers, alternation, backreferences and lookarounds are rejected. No organization-specific naming convention is hardcoded.

## History and data boundaries

Repository creation dates drive eras and historical snapshots; existing lifecycle, language evolution, time-lapse and activity/release effects remain available. Organization public events feed the shared activity pipeline. Public events are a limited recent window, not an entire organization's event archive. Contributor REST totals do not provide first/last contribution dates: `firstSeen` and `lastSeen` remain null rather than inferring tenure from repository creation. Historical contributor stars mean current contributors to projects existing in that era, not verified historical membership or contributor-growth counts.

REST repository metadata supplies languages and topics, not a dependency inventory. Dependency nodes accept explicit `dependencies` arrays in supplied repository fixtures; no dependency deep scan is performed by default. Complete release history and complete historical contributor growth are not inferred from these limited public sources.

API references: [public organization metadata](https://docs.github.com/en/rest/orgs/orgs#get-an-organization), [organization repositories](https://docs.github.com/en/rest/repos/repos#list-organization-repositories), [repository contributors](https://docs.github.com/en/rest/repos/repos#list-repository-contributors).

The three `organization-*.json` examples and gallery images use a synthetic community fixture; they do not represent Chingu or any real contributor history.
