# Developer Topology

Developer Topology places selected repository nodes near six evidence regions:
Interface, Services, Data, Systems, Tooling and Automation. The picture describes
the technical shape of the selected GitHub work; it is not a résumé, job title,
assessment of ability, seniority, or a percentage claim about a person.

The user chooses the repository set and any Featured, Supporting, Experimental
or Historical roles. Constellation does not assign or change those roles.

## Evidence dimensions

Mappings use exact normalized language and topic names. Topic normalization lowercases
and removes punctuation, so `github-actions` matches `githubactions`. Language
normalization preserves meaningful `+` and `#` suffixes: C, C++ and C# stay distinct,
and C# matches the CSharp alias. Unknown
languages and topics add no evidence. Topics are useful signals but are never the
only source: available language proportions and primary language names also
contribute.

| Dimension  | Language evidence                                                                                                           | Topic evidence                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Interface  | HTML, CSS, SCSS, Sass, Vue, Svelte; JavaScript, TypeScript, JSX and TSX contribute only when paired with an interface topic | frontend, interface, UI, web-components, accessibility, design-system, React, Vue, Svelte, Angular, CSS, HTML  |
| Services   | Go, Java, Kotlin, PHP, Ruby and C# contribute modestly; JavaScript/TypeScript also contribute when paired with a service topic  | backend, server, API, REST, GraphQL, authentication, WebSocket, Express, Node.js, services                     |
| Data       | SQL and PL/pgSQL                                                                                                            | database, PostgreSQL, SQLite, MySQL, MongoDB, Prisma, ORM, analytics, ETL, data-processing                     |
| Systems    | Rust, C, C++, Assembly and Zig; Go contributes modestly                                                                     | systems-programming, native, performance, WASM, WebAssembly, embedded, operating-systems, compiler             |
| Tooling    | Rust, Python, JavaScript and TypeScript contribute when paired with a tooling topic                                         | CLI, developer-tools, library, testing, build-tools, code-generation, linter, developer-utilities, tooling     |
| Automation | Shell, Bash, PowerShell, Makefile and Nix                                                                                   | GitHub Actions, CI/CD, deployment, Docker, infrastructure, automation, scripting, release-automation, platform |

For a repository with language byte counts, each matching language contributes
its fraction of the total detected bytes. If proportions are missing or all zero,
distinct language names contribute equally and every matching name counts.
JavaScript and TypeScript alone do not imply
an interface or service focus. A matching topic signal contributes 0.7 evidence units;
language mappings contribute the bounded weights encoded in Rust. Contributions
from one repository are capped before showcase weighting.

## Showcase weighting and scores

Each repository's evidence is multiplied by a deterministic, bounded role weight:

| Role             | Weight |
| ---------------- | -----: |
| Featured         |   1.35 |
| Supporting       |   1.00 |
| Experimental     |   0.65 |
| Historical       |   0.40 |
| No explicit role |   0.85 |

These weights express the user's showcase intent, not popularity. Stars and
activity do not affect profile evidence. Supporting, unassigned and lower-weight
projects continue to contribute. The internal dimension score is the weighted
evidence total divided by that total plus 2. Scores help rank evidence and select
the three strongest supported dimensions for a concise signature; they are not
shown as personality-style percentages. Every dimension includes repository IDs,
reasons and weighted contributions for inspection.

`profileEmphasis` accepts `automatic` or one of the six dimensions. A manual
emphasis multiplies that dimension's placement weight by 1.5. It moves positions
only; it does not change evidence, signatures, project roles or graph edges.

## Spatial layout

The Rust scene engine computes a repository's six affinities and places it at the
weighted centroid of six fixed, elliptical regions. Mixed evidence naturally
falls between regions. A repository with no recognized evidence keeps the
ordinary deterministic field position; no category is invented for it. Manual
coordinates still take precedence. Existing language, topic, membership and
project relationships remain the only graph edges.

Use `arrangement: "profile"` for a Developer Topology layout. Config version 7
remains unchanged and older designs continue to load. `profileEmphasis` is
optional:

```json
{
  "version": 7,
  "account": "octocat",
  "options": {
    "arrangement": "profile",
    "profileEmphasis": "systems",
    "projectShowcase": {
      "octocat/engine": { "role": "featured", "priority": 1 }
    }
  }
}
```

The same configuration works with the CLI and GitHub Action:

```sh
node src/cli.mjs build --username octocat --config constellation.config.json --output dist/constellation.svg
```

The Rust/WASM `developer_profile` function accepts a bounded JSON snapshot and
returns dimensions, scores, repository evidence, per-repository affinities and a
short evidence signature. `analyzeDeveloperProfile` exposes the same operation
from `@constellation/core`. Browser Studio, CLI, Action, Core and web component
use the same bundled engine and selected metadata. No profile-specific GitHub
request, polling or background customization request is made.

## Temporal topology

Choose `profile` as the temporal stack's inner arrangement to calculate a
separate evidence profile for each existing frame. Yearly frames reuse Timeline's
current-metadata and explicit-snapshot inclusion rules; language, topic and
repository planes reuse current-membership frames. Profiles never backfill a
language, topic or project into a frame without that frame's existing evidence.
Profile layers may place a repeated repository differently as evidence changes.
Other temporal arrangements keep their existing shared positions and 3D forms.

Retrospective years derived from creation dates still use current repository
metadata unless explicit snapshots were supplied. They are not historical
language byte counts, stars or activity. The profile reports that limitation
through each frame's evidence label.

## Output and accessibility

Developer Topology is available in Studio, CLI generation, Actions, static SVG,
offline interactive HTML and the packaged web component. Hero and Wide README
show a concise signature and subtle region labels. Compact output prioritizes
repository marks; its SVG description retains the evidence summary. Interactive
views expose keyboard-operable dimension buttons, combinations, clearing and
textual evidence in the inspector. SVG titles and descriptions identify the
summary and repository reasons. Reduced-motion preferences do not affect the
deterministic layout.

## Limits and privacy

The engine only sees the repository records already selected and loaded by
Constellation. Missing topics, language details, roles and snapshots stay
missing; no additional repository crawl is attempted. The profile stays in the
generated scene and export, and does not send data to a profile service. Static
exports are a snapshot of the selected public metadata and user-configured roles.
Review the included evidence before publishing: repository descriptions and
topic metadata may be incomplete or stale.
