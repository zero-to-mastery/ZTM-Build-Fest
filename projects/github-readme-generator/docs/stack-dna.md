# Stack DNA

After an opt-in manifest scan in **README audit**, **Stack DNA** summarizes evidence from the currently selected repositories. Deselecting a repository removes its technology evidence from the summary without fetching anything or changing your drafts.

The catalog is curated data, not AI classification. It matches exact normalized ecosystem/package identities. A similarly named package does not inherit a known technology's category. Unmapped packages remain **Unknown**, with their original normalized names and ecosystems available for inspection.

## Categories and summary groups

| Category         | Summary group    |
| ---------------- | ---------------- |
| Language         | Core             |
| Framework        | Core             |
| Runtime          | Core             |
| Testing          | Testing          |
| Build            | Build            |
| Database         | Data             |
| Styling          | Styling          |
| State Management | State Management |
| API              | API              |
| Deployment       | Deployment       |
| WebAssembly      | WebAssembly      |
| Utility          | Utility          |
| Unknown          | Unknown          |

Choose **Stack DNA category** to filter the summary. Select a technology to inspect its packages, dependency kinds, repositories and evidence. Each evidence line shows the same [Provenance and Confidence basis](stack-intelligence.md#provenance-confidence-and-staleness) as the repository results: Manifest path, section, line, basis, when and on which branch it was observed, and the shortened blob SHA. Conditional and ambiguous evidence also shows its explanation. Primary-language metadata is labelled as metadata, not a manifest declaration. Closing evidence returns keyboard focus to that technology.

A technology whose evidence is all conditional or ambiguous (for example a peer dependency only, or a `requirements.txt` line only) is labelled **only uncertain evidence** on its button and in its evidence. It is still shown, never hidden, but it is not promoted to an explicit result: Stack-to-README leaves it out of the Detected stack section and badges and offers it separately with its basis. Evidence from any explicit or inherited Declaration, or from primary-language metadata, removes the label.

For example, React and react-dom map to React; playwright and @playwright/test map to Playwright. RTL means [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/). Multiple matching packages or repositories become one technology with separate evidence. A development dependency stays labeled development even if its technology category is Framework.

## Evidence, not proficiency or runtime verification

Language evidence uses the existing GitHub primary-language metadata for JavaScript, TypeScript, Rust, Python and Go. The TypeScript compiler dependency also supplies explicit TypeScript tooling evidence. A package.json file alone does not establish Node.js or JavaScript.

Runtime signals for Node.js, Bun and Deno require explicit nonempty string declarations in package.json engines. These are configuration declarations, not proof that a runtime is installed or used. npm documents [engine requirements as advisory by default](https://docs.npmjs.com/files/package.json/).

Database mappings describe declared client/tooling evidence. For example, pg maps to PostgreSQL through the [node-postgres client](https://node-postgres.com/apis/client). Prisma or SQLx alone does not establish a particular database vendor. Deployment entries such as Vercel CLI do not prove that a site is deployed there.

GitHub Actions is not assumed from GitHub hosting or a build dependency. This manifest-only scan does not inspect workflows. React is not inferred from React Testing Library alone. Unknown never silently becomes Utility.

The summary has no developer ranking, proficiency assessment or quality percentage. “Stack DNA” is a descriptive view of available repository evidence. It does not automatically create profile skills, badges or README content.

## Coverage and limits

Partial and failed scans remain visible in coverage counts. Failed results contribute no technology evidence. Unknown/missing mappings are not proof that a technology is absent.

All data comes from the existing selected-repository scan and its session cache. No extra network calls, registry resolution, installs, scripts or repository execution are introduced. Details retain the first 100 distinct evidence records per technology while counting all associated repositories. Each summary group renders up to 100 technology controls; raw dependency evidence remains available in repository results.

Core combines the three related categories for readability; Data is the display label for Database. Ordering is deterministic, not a popularity ranking. The model deduplicates technology identities while retaining dependency kinds and repository associations.

## Maintaining the catalog

The versioned catalog lives in src/stack-intelligence/catalog.js. Each entry has an ID, display name, category and exact package names by ecosystem. The pure model in dna.js groups and associates evidence. Keep new entries narrow, check the upstream package purpose, add mapping/false-positive tests, and increment the catalog version when changing published mapping semantics.

Do not add keyword, substring, AI or transitive-dependency guesses. Tests cover category completeness, unique package mappings, ecosystem separation, aliases, unknowns, evidence retention and deterministic summaries across 100/500/1,000 repositories.
