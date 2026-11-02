# Changelog

## 5.2.0 — Star on GitHub, and link previews

- **Star on GitHub.** Home's footer and the How it works page link to the repository in a new tab, so visitors can star it without losing their place. Screen readers hear "(opens in a new tab)". Home's control budget in the perception tests rises from six to seven for this quiet footer link.
- **Link previews.** Both pages carry Open Graph and Twitter card tags with a 1200×630 preview image, `assets/og-image.png`. `scripts/build-og-image.mjs` draws it from the Studio's own example sky and headline, so it can be rebuilt when the look changes. A test checks the tags, the absolute image URL and the image's size.

## 5.1.1 — Sign in with GitHub, switched on

- **GitHub sign-in is live on the hosted Studio.** `index.html` now carries the GitHub App's client ID and the Netlify exchange address, so **Sign in** on Home offers **Continue with GitHub**.
- **Sign-in is offered only where it can work.** A new `constellation-oauth-redirect` meta value names the app's registered callback. The Studio offers GitHub sign-in only when it is served from that address, or its `index.html`, and always sends that address to GitHub. Local previews and forks that serve the same file keep the token form. When the value is empty, sign-in is offered on any address, as before.
- **Fix: the setup script works from PowerShell.** On Windows, `bash` in PowerShell starts WSL, which can't run the Windows Netlify CLI, so the script stopped with "Node.js is needed". It now recognises WSL and prints the exact Git Bash command. It also checks that the Netlify CLI runs, and no longer needs Node itself.

## 5.1.0 — How it works, and GitHub sign-in on Netlify

- **How it works page.** `how-it-works.html` explains Constellation in one page: a live example sky (drawn offline by the Studio's own engine, with **Layout** and **Theme** choices), the three steps, how to read the map, what signing in does and doesn't do, and what runs under the hood. Home's footer links to it instead of the docs folder, and credits the maker: "Made with ♥ by mnichols08".
- **GitHub sign-in exchange on Netlify.** `auth/netlify/functions/github-exchange.mjs` serves the existing exchange handler as a Netlify Function at `/api/github-exchange`, with a per-visitor rate limit. `netlify.toml` deploys only that function. `scripts/setup-sign-in.sh` walks the owner through registering the GitHub App and stores its public settings. The client secret goes straight from GitHub into Netlify's own settings page, and the script checks that it was stored as a secret. See [GitHub sign-in deployment](docs/github-oauth.md).
- **Fix: reduced-motion maps were zoomed in.** With moving rings, the still picture shown to people who prefer reduced motion was pinned to a fixed 900×560 box. Once a map was framed around its stars, that box no longer matched the visible area, so the still map appeared zoomed and cropped, including in README images. The picture now covers exactly the map's visible area.
- **Fix: headline contrast in light mode.** The orange end of the gradient word in the Home and How it works headlines fell to about 2.1:1 on the light background. Light mode now uses deeper stops that stay at 3:1 or better along the whole word. Dark mode is unchanged.
- Tests: a Netlify Function test, a framing test for the reduced-motion picture, and Playwright journeys for the new page (live example, layout and theme switching, keyboard, no GitHub requests, fallback without the engine) on all four browser setups.

## 5.0.1 — Layouts that survive wider fonts

- Fix Studio layouts that broke when the browser uses a wider font, as Linux does without Inter or Segoe UI (DejaVu Sans): on small phones Shuffle and Save shrank below 44px and the account chip lost its name; the star card's last button fell outside a short card at 320×568; and Fine-tune and the profile steps of **Get it** scrolled sideways at 320px. Top-bar controls no longer shrink, star card actions sit in an even grid, and long button labels in sheets and panels wrap.
- Run every Playwright journey twice more with a wide fallback font (`desktop-wide-font`, `mobile-wide-font`), so layouts are checked against font differences on every OS, not just the one they were written on.
- The perception checks wait for one-off animations (a dialog fading in) to finish before measuring, so a slow machine can't read a fading button as missing.

## 5.0.0 — Studio rebuild

The Studio's interface was rebuilt from scratch ([ADR-0008](docs/architecture/decisions/ADR-0008-STUDIO-REBUILD.md)). **Breaking:** the Studio interface is replaced. Engines, data and export contracts are unchanged. Guide: [docs/studio.md](docs/studio.md).

- **Three surfaces.** **Home** has one field and one action (**Show my sky**), plus **Try an example** (offline) and **Sign in**. The **Studio** gives the map at least 55% of a desktop screen (35% on a phone) and one panel with four tabs: **Look**, **Layout**, **Projects**, **Details**. The top bar holds **Undo**, **Redo**, **Shuffle**, **Save** and the single primary action, **Get it**, which offers five choices: **Add it to your GitHub profile**, **Download an image**, **Put it on a website**, **Share a link**, **Save the settings file**.
- **One store with Undo/Redo.** `src/app/store.mjs` holds the account, data, options and UI state. Every design change (settings, moved stars, featured and hidden projects, **Shuffle**, opened files) is undoable, up to 100 steps, with Ctrl+Z / Ctrl+Shift+Z. The draft autosaves and is restored with **Start fresh** on offer. The DOM is never read back as state.
- **Settings registry and Fine-tune.** `src/app/settings.mjs` defines every user-facing option once, with a plain label, help, group, control and how it reads and writes configuration. The tabs show the essential settings; **Fine-tune every setting** generates a searchable form for all of them, plus **Edit all settings as JSON** (validated, up to 250 KB) and **Start over with the default design**.
- **Live thumbnails.** Theme and layout choices are picture cards of the visitor's own map, drawn with the existing `createScene` and `renderSceneSVG`. Choices that can't work (for example **Through time** with projects from fewer than three years) say why.
- **Round orbits by default.** New Studio designs use `orbitShape: "round"` (added in 4.8.0): true circles instead of a 2:1 stretch. **Orbit shape** in the **Layout** tab switches back to Wide, which fills a README banner. Existing configurations keep their shape.
- **Motion.** New skies move gently (twinkling stars, slowly turning orbit rings). **Motion** in the **Details** tab offers **Still**, **Gentle** and **Lively** (faster rings, drifting stars), built from the existing animation options, which stay individually editable in **Fine-tune**. Reduced-motion preferences always win. Stars stay draggable unless they move themselves.
- **Star card.** Clicking a star (or Tab and Enter) opens a card with GitHub facts, **Feature it**, **Hide it**, **Open on GitHub**, and plain sentences on why it is there, where it sits, and what its size and colour show, each marked From GitHub, Worked out by Constellation, or Your choice.
- **Removed surfaces, and where their behaviour went:**
  - Guided setup wizard and questionnaire: Home's single field; new accounts start from the Project map preset with the Deep Space theme.
  - Studio tour: plain labels, the star card and a one-time map hint.
  - Simple/Advanced Studio: the four tabs and **Fine-tune**.
  - Design-code field: codes still decode from `?design=` share links; **Shuffle** replaces drawing new ones.
  - Randomizer lock matrix: **Shuffle** (look, layout and connections) with **Undo**.
  - Layer editor: `layers` in **Edit all settings as JSON** or a settings file.
  - Comet lab: **Highlight recent activity** in **Fine-tune**; detailed activity options in JSON.
  - Live tilt: **Tilt the map**, **Tilt amount** and **Turn amount** in **Fine-tune**.
  - Per-feature editors (ring points, temporal geometry, labels): Fine-tune fields, JSON, or dragging stars on the map.
  - The Studio no longer offers Profile Story downloads, semantic graph import/export, Semantic Markdown download, Developer Atlas navigation, a preset menu, or a Refresh data button. These remain available through Core, the CLI, the Action, or the `preset` share-link parameter.
- **Compatibility.** Config stays at version 7 and the new UI writes the same option keys. Share links keep their format; old links, including `?design=` codes, still open. Saved designs (`constellation-config-v1:<account>`) load unchanged. The CLI, Action, Core, Web Component, portable embed and portfolio artifact are unchanged. The old browser records `constellation-intent-v1`, `constellation-experience-v1` and `constellation-studio-tour-v1` are no longer read. `src/preview.mjs` and the `src/studio-*` modules are replaced by `src/app/`.
- **Tests and CI.** A Playwright suite in `e2e/` drives journeys on desktop (1440×900) and phone (390×844) with stubbed GitHub responses for typical, tiny, large, empty, organization, unknown, rate-limited and offline accounts. Every checked screen must have no overlapping controls, no unlabeled controls, no horizontal scroll, no engine jargon, exactly one primary action, a visible-control budget (Home 6, each tab 40), a map that meets its share and isn't blank, and no axe WCAG 2.2 AA violations. A new `ui` CI job runs `npx playwright test`. Browser tests that drove old Studio element IDs were removed; engine, package, CLI and component tests are unchanged. See [Studio budgets](docs/guided-experience-evaluation.md).
- **Dependencies.** None added in this release; the Playwright harness arrived in 4.7.1. Nothing is added to the shipped runtime.
- Docs: new [Studio guide](docs/studio.md); README, publishing, accessibility, designs, security and related guides rewritten for the new screens. [Guided setup](docs/guided-setup.md) now redirects there, and [Semantic Studio](docs/semantic-studio.md) keeps only how to read a constellation. ADR-0006 is superseded by ADR-0008.

## 4.8.0 — Round orbits

- Add `orbitShape: "wide" | "round"` to configuration. Orbit-based layouts (rings, galaxy, solar system, orbital, field and ring-meaning bands) have always stretched orbits about 2:1 so a map fills a wide README banner; `"round"` draws true circles instead. The Rust layout engine, SVG renderer, ring motion, snap-to-ring anchors, layout refinement and Galaxy/Solar system placement all share one horizontal reach. `"wide"` stays the default, so existing configurations, share links and published images render byte-for-byte as before. Organization layouts and the 3D time views keep their own geometry.
- Portfolio artifact validation accepts artifacts from Constellation 4.7 or later instead of only the 4.7.x line, so a minor release no longer breaks `--format portfolio`. Portfolio artifact v1, Scene v1 and the semantic contract versions still guard format compatibility; versions before 4.7 are still rejected.

## 4.7.1 — Perception test harness

- Add a Playwright harness (`playwright.config.mjs`, `e2e/support/`) that checks what a person actually sees: overlapping controls, controls without a visible label, horizontal scroll, engine jargon on screen, the map's share of the viewport and that it is not blank, one primary action per screen, axe WCAG 2.2 AA, and console errors or failed requests. GitHub is stubbed with deterministic fixture accounts, so runs are offline and repeatable. `@playwright/test` and `@axe-core/playwright` are development dependencies only; the Action and packages install nothing new.
- Fix the local preview server: a missing file returns 404 instead of 500, and WebAssembly is served as `application/wasm` without a charset suffix.
- Move Recruiter Evidence v1 derivation and deterministic project ordering into the bounded Rust/WASM core, keeping GitHub normalization, layout, and presentation in JavaScript. Full-name ties now use host-independent ASCII ordering instead of locale-sensitive JavaScript ordering, so punctuation-only ties can change order. Config v7, Scene v1, Evidence v1, Semantic Graph v1, and Web Component API v1 are unchanged.

## Unreleased — Portfolio Integration (v4.7.x)

- Add Portable Portfolio Artifact v1 with validated Scene v1, deterministic files, SHA-256 asset digests, explicit entry points, bounded manifest and bundle validation, and static SVG plus self-contained interactive HTML outputs.
- Add the offline CLI `--format portfolio` directory export and expose artifact creation and validation from Core. Studio's existing portfolio workflow prepares a downloadable package and framework-neutral embed guidance.
- Preserve project focus when a Web Component disconnects and reconnects, including evidence-backed relationship focus, without adding bytes to the 24 KiB component entry.
- Document plain HTML, React, and Astro integrations using the existing framework-independent Web Component and matching package releases; preserve Config v7, Scene v1, Evidence v1, Semantic Graph v1, and Web Component API v1.
- Release-candidate fixes: a `src` attribute set on a detached `<constellation-view>` after its `scene` property loads on connect again, while parsed elements still fetch once. Portfolio validation rejects Scenes that do not belong to the manifest subject (developer Atlas drill-downs into organization-owned projects remain valid), executable SVG attributes and URLs, and executable asset names beyond the generated HTML entry.
- No package publication, tag, or release is created by this development milestone.

## Unreleased — Guided Experience (v4.6.x)

- Extend Guided Setup with recommendation-first, plain-language intentions backed by the existing Projects, Technical Shape, and Journey candidates. Explain unavailable evidence and show a meaningful preview before publishing.
- Add Simple/Advanced Studio using the same existing controls and configuration. Mode switches preserve manual layout, labels, colors, CSS, animations, families, relationships, visibility, and roles without regeneration or network acquisition.
- Display the actual downloadable 480px and 900px Profile Story SVG bytes, included identities, featured projects, label visibility, relationship evidence, and advisory Story Clarity findings.
- Reuse the Publishing Wizard with destination-specific completion guidance, return-to-editing, and restorable per-account publishing choices. Optional CLI/Action story and target-width inputs share the bounded export pipeline; setup generation never claims verified publication.
- Preserve every public data contract, the 12-project cap, deterministic selection, publication integrity, and last-known-good refresh behavior. No Rust/WASM growth, framework, backend, or dependency additions.
- Add Chromium keyboard/mobile/reduced-motion, restoration, legacy/manual ownership, and byte-parity fixtures; provide offline timings and a manual usability procedure. Human participant testing and live-network timing have not been performed.

## Unreleased — Publish Once, Stay Current (v4.5.x)

- Add bounded publication manifest validation and stable source/configuration/artifact change classifications without adding fields to Config or Scene. The Node publisher hashes artifacts and records a versioned sidecar; incomplete evidence remains unknown.
- Validate SVG structure, accessible title and description, dimensions, size, filename, output branch, and workspace boundaries before publication. Generate to a temporary file and atomically replace the local output only after validation.
- Publish through an isolated Git worktree, preserve unrelated output files, serialize scheduled jobs per repository, retry concurrent non-fast-forward pushes without force, and skip commits when artifact bytes are unchanged.
- Report published, unchanged, and failed refreshes. Invalid generation and failed publication leave the last known-good output branch artifact intact; recover from a missing or malformed prior manifest on the next changed artifact.
- Add Studio destination and format guidance for profile READMEs, repository READMEs, and portfolio sites. README embeds stay static SVG; standalone interactive HTML is available for manual static hosting with an explicit preview and integration link.
- Document setup, manual versus automatic deployment, artifact limits, identity boundaries, and timestamp handling. Preserve existing semantic contracts; Rust/WASM remains unchanged because the publication work depends on Node hashing, filesystem, Git, and Actions orchestration.

## Unreleased — Interactive Exploration (v4.4.x)

- Add bounded Rust/WASM Evidence Navigation v1: a retained index over Semantic Graph v1 that returns a project's direct connections with evidence references for explicit, authored-family, shared-language, and shared-topic relationships, an optional bounded second degree, stable ordering, and structured diagnostics. Derived owner groups never become connections.
- Add project and relationship focus to interactive HTML and `<constellation-view>`: selecting a project dims unrelated projects without moving anything and lists evidence-backed connections; a relationship explains each reason and its origin and is never presented as a verified dependency.
- Make focus keyboard- and touch-friendly: Escape steps back one level with predictable focus restoration, focus changes are announced, inspector targets are at least 44 px, and dimming respects reduced motion.
- Add shareable focus as bounded `#focus=` URL state with Back/Forward support and safe fallback to the overview for removed, invalid, duplicated, or oversized focus links, which are removed from the URL. Web Component API v1 gains additive `focusProject`, `focusRelationship`, `returnToOverview`, `focusState`, and `focus-change`; URL state remains opt-in through `history` and an element ID.
- Reduce the WASM release binary with `codegen-units = 1` and keep standalone HTML within its 1 MiB runtime budget. Static SVG is unchanged. Preserve Config v7, Scene v1, Evidence v1, Semantic Graph v1, Semantic Markdown v1, Project Constellation v1, Atlas State v1, and Web Component API v1.

## Unreleased — Story Clarity (v4.3.x)

- Add bounded Rust/WASM Story Clarity v1 diagnostics for final-scene labels, hierarchy, evidence-backed relationships, technical groups, and legends. Diagnostics are deterministic and advisory; they do not score or select candidates.
- Export the same bounded Profile Story at compact 480px and wide 900px targets. Compact output prioritizes authored featured/supporting projects and reduces secondary labels and annotations without dropping selected projects.
- Keep manually positioned labels outside the compact label budget and Story Clarity suppression; hidden labels stay hidden, and automatic labels rank Featured, Supporting, then ordinary by stable project ID. Overlapping manual labels are reported rather than changed.
- Add a Studio composition inspector for authored project emphasis, relationship evidence, and presentation diagnostics; retain manual layout ownership and accessible SVG pathway patterns.

## 4.2.0 — Visual Storytelling

- Add bounded Rust/WASM Story Composition v1 for evidence-ranked language, topic, authored-family, and explicit project connections across the existing three story candidates.
- Annotate static SVG project links with semantic evidence, accessible line-pattern distinctions, and a compact multi-type legend; retain user-curated families and project roles.
- Preserve Config v7, Scene v1, Evidence v1, Semantic Graph v1, and the 12-project Profile Story limit.

## 4.1.0 — Useful by Default

- Generate bounded Projects, Technical Shape, and evidence-gated Journey views; recommend a deterministic, readable story while keeping Projects as the safe fallback.
- Add deterministic Rust Graph Quality v1 evaluation of visualization legibility, differentiation, evidence coverage, narrative structure, and unique project contribution.
- Simplify Studio's first view around the recommended story, with project filters and specialist controls behind Customize.
- Add a recruiter-focused story view using actual project names and source-backed technologies, with temporal storytelling disabled when dates do not support it.
- Preserve advanced presentation controls and user-authored project families; do not infer skills, seniority, or employability.
- Preserve Config v7, Scene v1, Evidence v1, Semantic Graph v1, Semantic Markdown v1, Project Constellation v1, Atlas State v1, and Web Component API v1.

## 4.0.1 — Atlas Continuity & Navigation Polish

- Preserve valid Atlas routes and entered group paths across compatible semantic refreshes; recover to the nearest valid parent and prune invalid history.
- Keep saved project selections tied to canonical GitHub repository identity across reordering and duplicate display labels.
- Reuse the current project's validated structure during the active session and clear it when semantic refresh cannot verify its scanned ref.
- Improve keyboard focus, route announcements, and narrow-screen Atlas navigation while keeping navigation separate from transient view state.
- Preserve Semantic Graph v1, Atlas State v1, Scene v1, Config v7, Evidence v1, Project Constellation v1, and Web Component API v1.

## 4.0.0 — Developer Atlas

- Add separate, versioned Atlas navigation state across Developer, canonical Semantic Groups, Projects, and loaded Project Constellation structure.
- Add Studio and Web Component breadcrumbs, bounded Back/Forward history, accessible context announcements, and route-preserving multi-group project navigation.
- Project group and focus scenes from existing Semantic Graph truth; preserve graph fingerprints, canonical JSON, provenance, Evidence v1, and Semantic Markdown during navigation.
- Keep imported graph navigation offline and show an explicit missing-structure notice without hidden network acquisition.
- Preserve Config v7, Scene v1, Evidence v1, Semantic Graph v1, Semantic Markdown v1, Project Constellation v1, and Web Component API v1.

## 3.14.3 — Portable Embed & Export Polish

- Load validated Semantic Graph v1 values directly into the Web Component or from an explicit graph URL, preserving the current view when replacement fails.
- Export standalone graph-backed HTML with subject, semantic fingerprint, coverage, and private-source disclosure.
- Add deterministic CLI portable bundles containing canonical graph JSON, Semantic Markdown, SVG, HTML, and a versioned manifest.
- Add direct Semantic Markdown download in Studio and align package versions at 3.14.3.

## 3.14.2 — Semantic Graph Import / Round Trip

- Treat canonical Semantic Graph v1 JSON as a portable offline artifact with validated Studio import, export, and CLI projection.
- Preserve exact canonical JSON bytes, fingerprints, provenance, Evidence v1, groups, project structure, visibility, and truncation across round trips.
- Add bounded UTF-8 JSON import, a stable filename convention, import trust-boundary documentation, and offline projection checks.

## 3.14.1 — Semantic Markdown

- Add a deterministic, bounded Markdown projection of Semantic Graph v1 for developer and project graphs, with provenance, private-repository warnings, and visible coverage limits.
- Preserve Config v7, Scene v1, Evidence v1, Semantic Graph v1, Project Constellation v1, and Web Component API v1.

## 3.14.0 — Portable Semantic Graph

- Added a bounded, deterministic renderer-independent Semantic Graph v1 with developer and Project Constellation adapters, provenance, evidence, completeness, serialization and Scene v1 projection.
- Preserved Config v7, Scene v1, Evidence v1, Project Constellation v1 and Web Component API v1.

## 3.13.0 — Project Constellations

- Add a bounded, deterministic project-structure model with stable path IDs, package/directory/module/entry-point nodes, evidence-backed containment, workspace and static import relationships, commit provenance, and explicit truncation statistics.
- Add opt-in bounded GitHub tree acquisition and an adapter to Scene API v1, including a child hierarchy API that reuses existing breadcrumb and Back navigation.
- Preserve source text outside normalized models and scenes. Keep Core normalization offline and independent of GitHub networking.

## 3.12.3 — Dense Export Polish

- Add a centralized, deterministic README density policy for static grouped SVG exports, with width-aware label budgets, bounded group/project sizing and bounded aggregate-edge weight.
- Separate crowded group labels in export geometry, retain group and user-curated labels before ordinary project labels, and keep suppressed labels accessible from SVG node titles.
- Add a compact shape/relationship legend and concise grouped-export accessibility summary. PNG inherits the same static SVG; offline HTML and Web Component interaction remain unchanged.
- Prefer grouped detail for dense README exports when groups exist, while honoring explicit Projects output. Preserve Config v7, Scene API v1, Evidence v1 and Web Component API v1.

## 3.12.2 — Group Evidence

- Explain user and repository-owner grouping reasons separately from bounded language/topic characteristics, with exact visible-member coverage and up to eight member examples.
- Preserve complete aggregate relationship counts, compute universal and partial evidence coverage across every represented source edge, and retain up to five deterministic real-edge examples.
- Use the shared group explanation in semantic projections and inspectors; add concise group wording to SVG accessibility descriptions. Preserve Config v7, Scene API v1 and Scene Evidence v1.

## 3.12.1 — Semantic Zoom

- Add Automatic, Groups and Projects semantic detail modes. Automatic follows camera scale through centralized enter/exit thresholds with hysteresis; explicit modes lock the projection.
- Expand the selected project's group first, keep unrelated groups collapsed, preserve the camera viewBox and group inspector context, and map collapsed project selection to its stable group ID.
- Debounce camera decisions, announce actual semantic transitions accessibly, and honor existing reduced-motion behavior.
- Support bounded automatic transitions in offline HTML and the Web Component. Preserve Config v7 and normalize legacy `enabled`/`level` options deterministically.
- Document focus behavior, limits, API and offline degradation; add state-machine regressions and transition benchmark output.

## 3.12.0 — Semantic Groups

- Add reversible semantic projections with stable user project-family IDs, conservative repository-owner suggestions, collapsed group nodes and aggregation of real cross-group edges.
- Extend Scene Evidence v1 to group subjects, explain user and derived grouping, and keep grouped SVG/HTML exports selectable independently of viewport scale.
- Add bounded `projectFamilies` and `semanticZoom` options without changing Config v7, Scene API v1, or Web Component API v1.
- Add Core hierarchy APIs and Web Component semantic level, expand and collapse controls; preserve source scenes and member project positions.
- Cap derived grouping at 256 projects, group definitions at 256, family membership at 2,048 per group and edge references at 256 per aggregate.
- Document semantic levels, provenance, config and API usage; add grouping, aggregation and export regression coverage.
- Keep derived group IDs stable as visible membership changes, describe owner evidence accurately, report capped aggregate-edge references, and compare family repository IDs case-insensitively.

## 3.11.0 — Evidence Everywhere Foundation

- Add optional bounded Scene Evidence v1 with source, user and derived provenance, without changing Config v7 or Scene API v1.
- Add Core explanation APIs and the **Why is this here?** disclosure in Studio and offline interactive HTML. Explain inclusion, position, visual mappings, manual overrides and evidence-backed connections; include structured evidence in CLI `--explain` output.
- Distinguish Identity Rings from Identity Orbits, use neutral wording for other deterministic layouts, and explain temporal layouts with their existing evidence.
- Record explicit repository selection as user intent and ordinary scene/filter inclusion as derived. Keep source provenance for provider facts and explain Showcase roles separately from inclusion.
- Use one shared pure explanation implementation across Studio, Core and offline interactive HTML. Preserve existing Developer Topology scores and role weights.
- Document evidence bounds, privacy and reuse. No AI service or network request is required.

## 3.10.0 — Simplify Constellation

- Make the first post-load action a one-click project map generated from the deterministic guided defaults; keep the questionnaire, presets, tour, saved designs and full Studio available as optional paths.
- After generation, offer plain-language starting points for exploring work, technical focus, project history and README output. Each maps to existing generator settings, normalizes only the dimensions required for that outcome and preserves curated project content.
- Organize the Studio into Content, Design, Layout, Motion and Export; place fine-grained layout controls under an Advanced layout disclosure. Move project connection and appearance details into the Content inspector and put output sizing with exports.
- Retain public exploration limits, authored Showcase roles, reduced-motion behavior and existing expert workflows.
- Describe the `orbital` arrangement as identity orbits, without claiming shared-technology grouping.
- Document the outcome-first path and compatibility boundaries; cover generated defaults and outcome actions in Studio browser tests.

## 3.9.2 — Documentation refresh

- Replace the long root README with a quick start, concise product overview, local setup and development notes.
- Add a documentation landing page organized around common user, embedding and contributor tasks.

## 3.9.1 — Recruiter simplification

- Focus the existing Recruiter SVG on seven curated projects: role-based sizes, three faint recency bands, clearer identity, primary languages and recurring factual topics.
- Remove moons, quarterly arcs, hollow planets and dense metadata rows from the default visual. Keep Featured contributor text and accessible evidence caveats, with quiet explicit relationships and a compact key.
- Preserve existing configurations and evidence extraction; update Studio guidance, documentation, example and README-width regressions.

## 3.9.0 — Recruiter README Orrery

- Add a Recruiter presentation to Showcase: developer sun, fixed repository planets, broad recency bands, observed active-month size buckets, primary-language colors and a permanent visual key.
- Reuse loaded public events, branch history and contributor scans. Label unknown evidence and lower bounds; show quarter continuity only with complete loaded branch history. Cap contributor moons at six with overflow counts.
- Preserve developer-authored Featured hierarchy independently of size. Distinguish verified external participation from external ownership alone; add up to six explicitly curated project-family links that survive configs, shares and randomization.
- Bound the composition to twelve projects, summarize other loaded repositories and recurring languages, respect reduced motion, and retain the other presentations and themes.
- Add evidence, configuration, Studio and README-scale browser coverage, an offline example, and rebuild Core/web-component packages for 3.9.0.

## 3.8.0 — Semantic Studio

- Make the constellation explain itself with a real Studio tour, entry paths and live configuration-derived Explain panel.
- Extend Rust Developer Topology evidence into a six-dimension Profile Sun and deterministic Capability, Showcase, repository-update and creation-era rings. Keep Identity geometry as the default.
- Label missing evidence, authored roles, current metadata, recency and decorative motion. Include evidence in accessible SVG descriptions and optionally append a static reading guide.
- Add story-oriented presets, composition scopes, randomization locks, What changed and Undo. Preserve roles and v1–v6 recipe behavior.
- Apply visual presets and random draws to cached data without implicit GitHub enrichment. Keep explicit loading and public exploration budgets intact.
- Add native Rust, WASM, configuration/export and browser coverage; regenerate WASM and package mirrors through build scripts.

## 3.7.3 — Ring alignment and account suns

- Fix animated ring alignment for projects with Showcase roles. Additional repository classes no longer exclude nodes from spin/sway animation; nodes follow their assigned points alongside labels and connections.
- Add an optional central account sun: Off, Sun + username, or GitHub avatar + glow. The sun shares the perspective transform without taking a node slot or changing ring assignments.
- Embed avatar images from GitHub's image CDN in Studio and CLI exports without consuming GitHub API quota. Unavailable images and offline fixtures fall back to initials. Preserve the choice in configs, share links and workflows.
- Add coordinate and browser regressions covering node counts, rotations, hidden nodes, manual reset, snapping, output profiles, perspective, animation and export parity. Regenerate the README example and rebuild package mirrors.

## 3.7.2 — Rate-limit-safe public exploration

- Public browser exploration loads account identity and one page of up to 100 recently updated public repositories. Primary languages and topics support project selection, Developer Topology, customization and exports without per-repository language requests.
- Manually add public repositories by name or URL, with up to ten metadata lookups per session. Cached additions survive refresh. GitHub sign-in enables complete discovery, language breakdowns, pins, contribution search, activity, contributor scans and commit history; token-backed local preview, CLI and Actions retain full analysis.
- Public requests go directly from the browser to GitHub. Rate-limit headers reserve five remaining requests, suppress further calls after limiting, and keep loaded snapshots usable with sign-in/reset guidance. Public refresh is scoped to account discovery.
- Added request-count, capability, cache and browser onboarding regressions, including anonymous creation and SVG export with primary-language evidence.

## 3.7.1 — Developer Topology review fixes

- Keep C#, C and C++ distinct during language normalization so C# supplies Services evidence instead of incorrect Systems evidence.
- Count every distinct matching language when byte proportions are unavailable, and retain readable evidence reasons when supplied byte counts are all zero.
- Retry temporary Windows DevTools port-file locks within the existing startup deadline. Preserve fatal I/O errors and all browser assertions.
- Add Rust and browser-harness regression coverage and rebuild WASM, Core and web-component artifacts.

## 3.7.0 — Developer Topology

- Add a deterministic Rust/WASM developer profile engine for Interface, Services, Data, Systems, Tooling and Automation evidence from selected repositories, language proportions, topics and explicit Showcase roles.
- Add the `profile` semantic arrangement with bounded, documented role weights, inspectable evidence, manual emphasis, spatial region labels and concise signatures; preserve real graph edges and manual positions.
- Integrate dimension exploration and evidence inspection into offline interactive output, guided setup previews, config/share links, temporal layers and static README SVG profiles without adding GitHub requests.
- Keep config v7 backward-compatible; document mappings, score normalization, temporal limitations, API behavior and privacy. Rebuild Rust/WASM, Core and web-component artifacts.

## 3.6.1 — 2026-09-30

- Allow up to 60 seconds for cold Chrome startup on hosted CI runners after release-tag verification exposed starts exceeding the previous 15-second deadline.
- Give browser tests 120 seconds overall so startup does not exhaust the assertion budget. Preserve bounded waits, process cleanup, serial execution and all application assertions.
- Include the GitHub request-cache improvements from 3.6.0; update Core and web-component package versions.

## 3.6.0 — GitHub Request Efficiency

- Share identical concurrent GitHub REST reads across Studio, organization, contribution, activity, language and commit loaders; retain independent response bodies for each consumer.
- Add bounded 15-minute versioned request caching for public data across Studio reloads and CLI runs, with ETag revalidation, explicit-refresh bypass, auth-context isolation and refresh-race protection.
- Respect `Retry-After` and rate-reset cooldowns without repeated retries; keep failed responses retryable and authenticated response bodies out of persistent storage. GraphQL POSTs remain uncached.
- Forward conditional requests and `304` responses through the local proxy. Customization and rendering continue to use loaded snapshots, with no background polling.
- In a deterministic mock, independent contribution and commit loaders use 2 GitHub GETs instead of 3 by sharing repository metadata; this fixture result is not generalized to other request paths.
- Add request-cache, CLI persistence, refresh-race, auth, cancellation, rate-limit, proxy and browser regression coverage. Rebuild Core and web-component package outputs.

## 3.5.2 — 2026-09-30

- Run test files serially after release-tag verification exposed Chrome startup timeouts with two concurrent workers.
- Give Linux test browsers private writable cache/config directories, avoid constrained shared memory on Actions, and wait for browser exit before deleting profiles.
- Use the shared browser harness for the Studio integration suite so startup and cleanup fixes apply to every browser test. Keep all application assertions enabled.

## 3.5.1 — 2026-09-30

- Fix an intermittent browser-test startup failure by waiting for a complete, valid Chrome DevTools port file instead of accepting an empty or partial write.
- Limit JavaScript test-file concurrency to two to reduce concurrent Chrome startup contention in CI while retaining all browser checks.
- Add startup regression coverage for missing, empty, partial and invalid port files and exited browser processes; update Core and web-component package versions.

## 3.5.0 — README Showcase

- Add explicit Featured, Supporting, Experimental and Historical project roles with bounded featured order. Roles remain separate from GitHub stars, activity, archive status and topics, survive randomization and daily generation, and are retained when a project is temporarily unavailable.
- Add Featured Project Gravity to node scale, glow, label priority, existing-edge visibility, category membership emphasis and optional bounded text spotlights. Featured ecosystem emphasis uses only real repository/language/topic membership.
- Add identity, importance, activity and manual ring organization. Importance assigns existing stable ring anchors by role and leaves saved manual coordinates intact.
- Add a project-role curation step to guided setup, accessible reorder controls, README presentation choices, and a dedicated Showcase section in Studio.
- Add Full universe, Featured work, Current focus, Technology identity and Project journey presentations. Activity and chronology use available public data only and degrade without fabrication.
- Add Hero (900 × 560), Wide README (900 × 320), Compact (900 × 180) and Square (480 × 480) export profiles with adjusted label/background density; preserve high-priority labels and bounded spotlight fallback.
- Prioritize Featured repositories and their real category memberships when output node limits reduce the graph, while retaining the existing Rust/WASM membership and layout engines. Add configuration, SVG, onboarding, share/workflow, browser and package-consumer regression coverage; rebuild Core and web-component mirrors.

## 3.4.1 — 2026-09-30

- Add Pinned repositories to onboarding project choices. Load authenticated public profile pins on demand, including projects owned by other accounts, and keep individual selection editable.
- Preserve the existing selection for empty or failed pin requests; explain sign-in requirements for anonymous users. Defer language details and activity requests until needed.
- Cover keyboard selection, public/private boundaries, pins from other owners, back navigation, empty/error states and anonymous use. Rebuild package mirrors.

## 3.4.0 — 2026-09-30

- Generalize the existing Universe layer/geometry engine to Year, Language, Repository and Topic axes. Preserve Timeline evidence and continuity rules for years.
- Represent current memberships with semantic v2 attachment layers and isolated frames, without fake dates; retain v1 year attachment parsing and config v7.
- Rank and bound default layers, accept explicit ordering, connect repeated identities across dimensional planes, and populate repository planes with the existing combined language/topic/project graph.
- Add Stack by, searchable layer values and ordered selection to Studio, dimensional choices to onboarding, and layer focus to offline HTML and web components. Preserve shared geometry, manual placements, motion and reduced-motion rendering.
- Add membership/ordering/validation, legacy year, SVG, offline HTML, mobile Studio and packaged-component coverage. Validate 320 JavaScript tests, 34 Rust tests, CLI SVG/HTML exports for all dimensional axes, and six temporal scaling cases. Rebuild package mirrors and document the model and API.

## 3.3.0 — 2026-09-30

- Add GitHub App authorization-code sign-in with strong state, S256 PKCE, one-use callbacks and an isolated secret-bearing exchange service. Hosted onboarding no longer asks for a pasted token; anonymous exploration and local/CLI/Actions tokens remain available.
- Automatically use authenticated identity, show profile details, support sign-out and returning local designs, and keep credentials outside design storage and exports.
- Rework guided creation around visual project cards, relationship choices, optional illustrated activity and universe structure; retain advanced Studio, keyboard/mobile support and lazy activity requests.
- Add OAuth security/callback/returning-user tests and deployment instructions. Actual hosted sign-in requires owner registration and deployment of the new GitHub App and service; automated tests use simulated GitHub responses.
- Rebuild Core and web-component mirrors.

## 3.2.2 — 2026-09-30

- Retire Story creation from Studio navigation and exports; remove the unused Studio editor. Remove promotion from onboarding, README and the current example gallery.
- Preserve Story v1 parsing, validation, rendering, chapter navigation and public Core/component APIs as legacy v3 compatibility. Existing JSON imports remain supported through parseScene.
- Replace editor tests with a browser retirement check; retain the Story compatibility and component suites. Rebuild package mirrors.

## 3.2.1 — 2026-09-30

- Trace DEP0040 to the bundled URL/IDNA dependencies in actions/setup-node@v4 (setup and post cleanup), reproduced locally with --trace-deprecation and confirmed in Actions runs 36651175270 and 36640876904. Constellation runtime paths do not import deprecated Punycode APIs.
- Upgrade setup-node and checkout to v6 in owned workflows, the composite action and exported workflow templates; retain Node 22 and explicitly disable unneeded automatic dependency caching. No npm dependency added.
- Add URL/Unicode-host regression checks and deprecation guards. The GitHub-managed Pages workflow also warned in upload/deploy actions (run 36640851661); its upstream action versions are managed by GitHub, outside these files.
- Rebuild Core and web-component mirrors.

## 3.2.0 — 2026-09-29

- Remove decorative ships and flight paths from commit asteroid fields; retain author colors and clickable commit asteroids.

- Add direct GitHub token sign-in to the hosted Studio, verify account identity, and start guided setup automatically.
- Enable hosted live pinned-repository previews and authenticated public-data requests without a local server.
- Keep tokens only in page memory, with sign-out, rejected-token handling, cancellation and credential confinement to GitHub's API.
- Preserve anonymous browsing and local `.env` authentication. Hosting remains GitHub-only; OAuth redirect sign-in is deferred pending an external backend.
- Rebuild Core and web-component packages at 3.2.0.

## 3.1.2 — 2026-09-29

- Fix temporal SVG previews and exports silently becoming static when ring, floating and perspective animation periods have a long shared cycle.
- Use a bounded forward-and-back SVG loop for those combinations while interactive HTML retains continuous motion; preserve reduced-motion and animation-off behavior.
- Verify automatic movement in the Studio browser preview and standalone SVG, loop continuity and the existing offline motion controls.
- Rebuild Core and web-component packages at 3.1.2.

## 3.1.1 — 2026-09-29

- Start guided setup immediately from account entry, including accounts with an existing draft, without overwriting the saved design.
- Make the Guided setup button usable from the sample Studio and show loading progress and retry errors immediately.
- Load repository metadata first and fetch language details only for selected projects when continuing.
- Move title, save, fullscreen and library controls below the preview; keep the header compact and the mobile workspace bounded.
- Validate 299 JavaScript tests, including real pointer clicks, draft preservation, deferred language loading and mobile preview controls.

## 3.1.0 — 2026-09-29

- Introduce onboarding-first setup with project recommendations, language/topic choices, optional activity and history, constrained regeneration, export and full Studio customization.
- Add Temporal Universe stacks and true 3D forms, ring placement, temporal motion and compatible SVG, interactive HTML and component rendering.
- Add seeded v6 temporal design recipes while preserving previous recipe formats and config v7 compatibility.
- Restore background stars and classic dust in temporal scenes; keep the project credit visible independently of annotation visibility and opacity.
- Preserve account drafts, shared views and repository discovery; load guided activity on demand with recoverable failures and no fabricated account data.
- Rebuild Core and web-component packages at 3.1.0 and document guided setup and temporal geometry.
- Add fullscreen previews, editable constellation titles and a local library of named designs; default contribution discovery to all organizations.
- Make returning visits guided by default, keep customization opt-in and make skipping topics clear its filter and advance.
- Validate 298 JavaScript tests, including browser onboarding, export, temporal rendering and external package consumers.

## 3.0.0 — 2026-09-27

- Declare the scene-based platform stable: Scene/Renderer/Layout/Web Component/Story v1, Plugin/Source v2, Theme v2 and config v7.
- Ship rebuilt core/component 3.0.0 packages and additive source-json/themes 1.1.0 releases with explicit package boundaries and no runtime npm dependencies in core.
- Preserve v6/legacy configuration, recipe and SVG compatibility; document required WASM and the complete v2 → v3 migration.
- Keep the final v2 release at 2.9.3 and introduce v3/3.0.0 Action tags. No new features beyond the release candidate.
- Verify 234 JavaScript tests, 34 Rust tests, seven scaling benchmarks, external package consumers and unchanged original SVG gallery artifacts.

## 2.9.3 — 2026-09-27

- Finalize config v7 and idempotent v2 → v3 workflow/config migration while preserving v6 and legacy recipes.
- Stabilize Scene/Renderer/Layout/Component/Story v1, Plugin/Source v2 and Theme v2 contracts, retaining legacy source/theme adapters.
- Require bundled Rust/WASM and report accessible startup failures; remove deprecated JavaScript computational fallbacks.
- Harden composed scene limits and source validation; add migration, external source, missing-WASM browser/Node checks and a Story benchmark.
- Complete architecture, extension, accessibility, security and v3 migration guides.

## 2.9.2 — 2026-09-27

- Add an optional Studio Story tab to capture current scenes, duplicate/rename/reorder/remove chapters and edit narration.
- Preview from the active chapter in an isolated iframe; export standalone HTML or scene JSON and import saved stories.
- Keep ordinary constellation controls separate and load HTML export assets on demand; test editing, sandboxed player execution and JSON round trips in Chromium.

## 2.9.1 — 2026-09-27

- Interpolate shared node positions, sizes, colors and opacity between story chapters while retaining node groups.
- Animate camera changes, cancel superseded transitions, and finish immediately when reduced motion is requested.
- Preserve manual chapter controls and accessible narration/focus; test identity, camera completion and reduced-motion behavior.

## 2.9.0 — 2026-09-27

- Introduce Story format v1 with ordered declarative chapters, scene references/definitions and validated camera, selection/path, filter, timeline, theme, annotations and layer state.
- Compile chapter layout changes through the existing Rust-backed pipeline; escape annotations and narration.
- Add offline HTML/component story controls and static first-scene fallback, with compilation and browser tests.

## 2.8.3 — 2026-09-27

- Harden cycle and maximum-depth validation across shared branches and temporal child references.
- Bound remembered scene view state to eight entries, restore camera/filter/theme/selection, and delegate navigation handlers to avoid listener accumulation.
- Validate malformed deep links, retain accessible breadcrumb focus, and add hierarchy export benchmarks and a runnable organization demo.

## 2.8.2 — 2026-09-27

- Add interactive child-scene exploration, breadcrumbs, Back/Home and shared-node scene transitions.
- Serialize navigation paths into shareable URL fragments and restore them on reload/browser history navigation.
- Keep embedded history opt-in and namespaced by element ID; validate custom styling across child scenes and preserve generic category tooltips.

## 2.8.1 — 2026-09-27

- Build organization → repository detail scenes from already-loaded project, language, topic, dependency and contributor metadata.
- Bound child generation, preserve scan-coverage notes, exclude private repository references, and make no additional API requests.
- Test verified contributor/technology membership and document honest scope/provenance.

## 2.8.0 — 2026-09-27

- Introduce declarative hierarchical scene catalogs with node-to-child references and supplied scene definitions.
- Compile children through existing pipelines/layouts, preserve static root SVG fallback, and serialize deterministic catalogs.
- Validate references, cycles, size bounds and cancellation; document data provenance and programmatic authoring.

## 2.7.3 — 2026-09-27

- Add bounded, observable per-host timeline caching with cloned results, cancellation and custom-layout bypass.
- Support canonical record inputs and supplied activity snapshots; enforce 64 frames and 16,384 aggregate frame nodes.
- Test sparse/empty history, large frame counts, eviction and abort behavior; validate embedded CSS across every frame.
- Add a runnable timeline example and cache/export-size benchmark; document historical evidence and scaling limits.

## 2.7.2 — 2026-09-27

- Add labelled date scrubbing, Then/Now shortcuts and nearest-snapshot date selection.
- Compare the selected date beside a static Now view with synchronized camera, responsive layout and explicit added/removed counts.
- Expose timeline navigation/comparison through the component and test evidence-aware comparison in offline HTML.

## 2.7.1 — 2026-09-27

- Interpolate shared-node positions and sizes between precompiled timeline scenes while preserving node DOM identity.
- Fade arriving/departing nodes, refresh relationships/styles, and retain camera, filter, theme and valid selection state.
- Cancel transitions on navigation/disposal and immediately honor reduced-motion changes; test identity and motion behavior in the browser.

## 2.7.0 — 2026-09-27

- Introduce a versioned temporal scene model with explicit reference dates, supplied historical snapshots and labelled current-metadata creation-date views.
- Expose reliable created/updated/release metadata without inventing historical metrics; bound and validate frame dates.
- Add offline Previous/Next date controls to HTML and component runtimes, static latest-scene SVG fallback, config integration and deterministic timeline tests.

## 2.6.3 — 2026-09-27

- Verify the web component and core from an isolated external-consumer directory, including WASM/module loading and strict imported styling.
- Assert accessible controls in Chromium, keyboard operation, package manifests and package-size budgets.
- Complete bundler/import-map deployment, package responsibility and accessibility documentation; rebuild extensions and check HTML size budgets in CI.

## 2.6.2 — 2026-09-27

- Support lazy component initialization with IntersectionObserver and responsive runtime ResizeObserver cleanup.
- Cancel superseded/disconnected JSON loads and let explicit property updates supersede a source URL.
- Bound per-instance source caches, expose cache statistics/reload, clear computational caches on disconnect, and restore views on reconnect.
- Test two-instance isolation, lazy visibility, abort races and lifecycle disposal in Chromium.

## 2.6.1 — 2026-09-27

- Expose component selection, clear, fit/reset, filtering, theme, setConfig and loadScene methods.
- Emit scene-ready only once the imperative API is usable, scene-change on replacement, and composed selection/hover/error events.
- Validate strict configuration styling before updates and test API/event behavior across independent elements.

## 2.6.0 — 2026-09-27

- Add the browser-only @constellation/web-component package and `<constellation-view>` custom element.
- Accept JSON configuration, records and compiled scenes through properties, attributes and HTTP(S) JSON loading.
- Reuse the scene SVG renderer and interactive runtime inside Shadow DOM; add an import-map demo and browser tests.

## 2.5.3 — 2026-09-27

- Add a deterministic hash-based Content Security Policy to offline HTML; disallow network connections and injected scripts/handlers while permitting bundled WASM.
- Validate imported scene palettes, graph presentation and geometry bounds; escape activity attributes defensively.
- Report HTML/runtime/scene/WASM sizes and benchmark 45, 256 and 2,048 nodes. Expand browser escaping, CSP, keyboard and reduced-motion checks.

## 2.5.2 — 2026-09-27

- Add local text/language filters and original, midnight and light theme switching to interactive exports.
- Keep keyboard targets and Rust path traversal aligned with visible nodes; clear selections hidden by filtering.
- Observe responsive canvas sizes and reduced-motion changes, including pausing SVG animation; clean up observers on disposal.

## 2.5.1 — 2026-09-27

- Add node details, safe project links, and explicit selection/path state to interactive exports.
- Shift-click or Shift-Enter traces shortest paths using the bundled Rust/WASM engine; ordinary selection reveals neighbours.
- Embed WASM and bindings for offline traversal; test links, escaping, highlighting and keyboard controls in Chromium.

## 2.5.0

- Add self-contained interactive HTML export from compiled scenes and CLI `build --format html`.
- Support pan, cursor-centred zoom, hover, selection, click-to-focus, fit/reset and keyboard controls.
- Add offline browser and CLI tests, escaped embedded data, and a runnable HTML example. Static SVG remains the default.

## Unreleased

## 2.4.3 — 2026-09-27

- Add bounded, observable per-host caches for deterministic registered layouts; bypass retention for nondeterministic/non-JSON inputs and isolate all returned positions.
- Check cancellation across diagnostics, callbacks and WASM boundaries. Document synchronous preemption limits and expose existing engine cache counts.
- Add layout stage benchmarks, 2,048-node/manual-position regressions, cancellation/cache tests and external-consumer checks. Package the layout author guide.

## 2.4.2 — 2026-09-27

- Add per-host trusted layout registration with snapshotted callbacks/capabilities and isolated scene/options inputs.
- Allow declarative layout references and options while rejecting module URLs and requiring explicit registration at render time.
- Validate complete finite position results and capability requests, preserve manual overrides, and retain Rust relationship construction/refinement. Add working extension docs and registration tests.

## 2.4.1 — 2026-09-27

- Expose layout capability metadata for graph sizes, manual positioning, ring snapping, deterministic seeds, animation, refinement and WASM requirements.
- Diagnose effective stable-overview selection and reject unsupported graph sizes before invoking the engine.
- Add capability isolation, mode-boundary and diagnostic tests; document capability semantics without changing layout defaults.

## 2.4.0 — 2026-09-27

- Route all existing arrangements and stable large-graph overview through a scene-based layout interface returning ID-keyed positions.
- Move artifact/organization/temporal position adapters to the layout boundary while retaining the canonical Rust graph engine, manual overrides and all defaults.
- Isolate returned layout data from engine caches and test built-in determinism, manual positioning and original SVG parity. Document the transitional layout contract.

## 2.3.3 — 2026-09-27

- Add explicitly owned normalization/transform caches bounded by entries and estimated bytes, with isolated results, observable hit/miss accounting and clear operations.
- Expose stage counts and cache diagnostics through CLI scene inspection; add pipeline details to advanced `--explain` output while preserving the ordinary filter report.
- Benchmark normalization, transforms, graph and scene/layout separately. Test eviction, oversized/non-JSON inputs, cancellation and independent hosts.
- Preserve source records whose metadata uses a `type` field, retain derived metrics, and document pipeline authoring and measured costs.

## 2.3.2 — 2026-09-27

- Add declarative size, color, glow and opacity mappings with simple stars/language/activity/age forms and safe field/expression forms.
- Support bounded numeric scales, categorical hex colors and explicit missing-value fallbacks; keep manual node color precedence and pass mapped sizes to Rust refinement.
- Preserve derived metrics through transforms, isolate historical metadata, and keep invisible mapped nodes out of keyboard interaction. Add mapping validation and parity tests.

## 2.3.1 — 2026-09-27

- Add deterministic declarative filter, sort, limit, derive, group, map and deduplicate transforms with isolated outputs and stage reports.
- Add a bounded data-expression tree for safe field access and arithmetic/text operations, rejecting executable values and prototype paths.
- Preserve privacy/fork exclusions before transforms and historical evidence before frame transformations. Studio now inspects the compiled scene's actual graph.
- Test config round trips, grouping, ordering, mutation isolation and unsafe input rejection; document working transform examples.

## 2.3.0 — 2026-09-27

- Route scene compilation through isolated normalized data records with stable IDs, labels, kinds, metrics, source provenance and preserved metadata.
- Keep source API 1 loaders working; add normalized plugin-host loading and a compatibility adapter to the existing graph interface.
- Report rejected records and pipeline counts, prevent ID collisions, and test rendering parity, isolation and cancellation. Document the data pipeline.

## 2.2.3 — 2026-09-27

- Apply annotation visibility/opacity to time-lapse captions and honor disabled highlights during Studio keyboard selection while retaining node details.
- Omit zero-opacity layer markup to avoid invisible interactive targets; report visibility consistently in scene statistics.
- Harden layer config/share/workflow round trips and escaping, add temporal and browser regressions, and ship a runnable layered gallery example.

## 2.2.2 — 2026-09-27

- Add a focused Studio Layers inspector with native keyboard selection, scene counts, per-layer visibility/opacity/order, reset and links to relevant existing settings.
- Compile the Studio preview through the scene interface and preserve layer settings when restoring configs, sharing and exporting workflows.
- Keep the first-visit landing and simple Look workflow unchanged. Browser tests cover layer editing, invalid-order recovery, focus navigation and exports.

## 2.2.1 — 2026-09-27

- Add declarative v6 layer visibility, opacity and ordering controls, preserving all defaults and coordinates.
- Validate order constraints around backgrounds, connections, nodes and labels; preserve deterministic tie ordering and fixed camera phases. Selection supports visibility without inventing a separate opacity behavior.
- Preserve controls through scene/config/workflow export and test malformed controls, ordering and unchanged node geometry.

## 2.2.0 — 2026-09-27

- Render scenes through ordered background, effects, starfield, rings, connections, nodes, labels, annotations and selection layers.
- Preserve camera and historical-animation semantics through fixed composition phases; logical starfield/annotation layers can contribute to multiple phases.
- Validate and serialize layer type/phase records, add composition tests and document the layer architecture. Default SVG bytes remain unchanged.

## 2.1.3 — 2026-09-27

- Add separate scene compile/serialize/parse/render benchmarks and a forced-GC retained-memory check for repeated 2,048-node processing.
- Test large-scene references, label bounds and isolation, every existing example config, and scene API consumption outside the repository.
- Include scene documentation in the distributable core package and document measured performance and memory costs. Existing SVG byte fixtures remain unchanged.

## 2.1.2 — 2026-09-27

- Add CLI `--scene` statistics/diagnostics and `--scene-json` inspection without SVG, cache writes or Action outputs. Support explicit JSON output paths and dry runs.
- Add `--reference-date` for reproducible CLI generation, `sceneStatistics` for hosts, and plugin-host scene compilation retaining custom icons and themes.
- Test offline inspection, exact fixed-date repeatability, mutually exclusive output modes and dry-run/Action output boundaries.

## 2.1.1 — 2026-09-27

- Canonicalize scene JSON key ordering and add a fixed-date scene snapshot alongside original SVG parity fixtures.
- Validate scene IDs, edge references, geometry, style, labels, ordered layers and temporal frames. Reject cycles, executable records, unsafe keys and non-finite numbers before serialization/rendering.
- Expose diagnostic validation and bounded scene parsing; test determinism across cache state and record property ordering.

## 2.1.0 — 2026-09-27

- Introduce isolated, serializable scenes with node/edge IDs, geometry, styling, interaction metadata, labels and layer identities. Keep Rust/WASM as the layout engine.
- Split scene compilation from SVG rendering, preserving the existing rendering entry point and source icon callbacks. Historical crossfade renders precomputed scene frames.
- Add original-renderer byte fixtures and scene round-trip tests; preserve the generated gallery byte for byte. Document baseline architecture and the transitional scene contract.

- Restore the original landing layout on the first browser visit, open the studio directly on later visits and shared links, and hide the landing-to-studio loading flash.

- Add a searchable repository picker in the Projects panel, with explicit selection, bulk controls and automatic selection. Preserve chosen repositories in configs, presets, share links and workflow exports.

- Load missing project data when applying built-in presets, and restore the previous design if loading fails or the preset renders no visible nodes. Only report success after updating the graph and exports.

- Preserve curved connections during ring and floating animation, keeping endpoints attached across independent motion speeds.

- Add adaptive Chingu and Code the Dream themes to the studio, core and theme packs, using their public brand palettes.
- Freeze the v5 recipe theme choices so adding themes preserves previously shared designs.

## 2.0.0 — 2026-09-27

- Export a single v6 config format incorporating refinement, plugins, theme packs and node-cap settings. Automatically read legacy version-1/unversioned configs, frozen v1:–v5: recipes and old share links.
- Add offline `migrate --config`, `--from` and `--workflow` commands with a complete migration guide. Preserve resolved appearance and manual/hidden-node settings; keep legacy recipe seeds as provenance.
- Commit to source API version 1 and the documented theme contract throughout core 2.x.
- Explicitly deprecate the non-WASM browser fallback with a load-time warning; removal is deferred to the next major. CLI/Action WASM requirements remain unchanged.
- Update Action/Marketplace metadata, generated workflows and README quick-start to v2. No new visualization features are introduced.

## 1.9.3 — 2026-09-27

- Bound source-cache retention by an 8 MiB estimated serialization budget as well as entry count; oversized snapshots remain usable without being retained.
- Add cache accounting and a repeatable forced-GC profiling script. Twelve 2048-node metadata-heavy snapshots previously retained about 43 MiB on the development host.
- Test budget eviction and full accounting reset on clear.

## 1.9.2 — 2026-09-27

- Cache source responses only after validating every node, so malformed feeds can be retried without a forced refresh.
- Reject responses completed after cancellation even when a custom loader ignores its signal.
- Regression tests prove a late pre-refresh response cannot replace the new snapshot, and invalid/cancelled loads do not become cached data.

## 1.9.1 — 2026-09-27

- Replace repeated all-node ring-occupancy scans in large overviews with a spatial index, preserving exact distance tests and node order.
- Add a 2048-node style-change benchmark with ring snapping on/off and computed-node counters. Add boundary-equivalence regression tests.

## 1.9.0 — 2026-09-27

- Add an opt-in stable overview with configurable node caps up to 2048, sparse relationships and bounded automatic labels. Existing configs retain their original layouts and limits.
- Compute overview coordinates in Rust by account/seed and node ID, caching each node independently so style/filter changes reuse unaffected coordinates without history-dependent output.
- Cache plugin source snapshots separately from view settings, with explicit refresh and stale pending-load rejection.
- Extend projection, ring geometry, graph exploration and refinement bounds for larger graphs; regenerate WASM.

## 1.8.3 — 2026-09-27

- Ship an executable offline plugin example using separately packaged source and theme modules, two source instances and a custom diamond renderer.
- Add package READMEs and author guidance for metadata, cancellation, errors, credentials, deterministic fixtures and host integration.

## 1.8.2 — 2026-09-27

- Preserve independently bumped extension package versions during builds; the themes package is now 1.0.1 while unchanged pack content remains 1.0.0.
- Reject ambiguous release versions and non-styling theme payload fields. Fix resolution of an external theme pack named `custom`.
- Regression coverage checks exact versions, styling-only payloads and external theme resolution.

## 1.8.1 — 2026-09-27

- Snapshot registered source callbacks and source-instance config before asynchronous loading so caller mutations cannot change IDs or implementations mid-load.
- Reject graph ID collisions when combining plugin and application data; clone returned metadata and honor cancellation before each loader.
- Regression coverage exercises a paused load, caller mutation, duplicate merged IDs and cancellation.

## 1.8.0 — 2026-09-27

- Add isolated source registries, namespaced source instances, duplicate-ID errors and a working JSON-feed source for the core and CLI/Action.
- Package existing Look presets as independent 1.0.0 theme packs, with exact references or portable embedded presets.
- Add node-renderer hooks for custom SVG paths while retaining node metadata and hit targets.
- Document the source authoring contract, JSON-feed example and GitLab extension point. Preserve plugin and theme config in existing exports.

## 1.7.3 — 2026-09-27

- Add `--help`, `-h`, and `--version`; clarify package-engine recovery errors.
- Document package installation, CLI exit status, JSON output, offline fixtures, dry-run effects and exclusion reasons.
- Preserve actionable errors for primitive refinement settings instead of leaking an `in`-operator TypeError.

## 1.7.2 — 2026-09-27

- Report malformed node-color IDs, invalid ring arrays (including sparse arrays), and non-integer/out-of-range refinement intensity with specific field paths.
- Return multiple independent validation errors together; preserve category IDs containing spaces and valid angle endpoints.

## 1.7.1 — 2026-09-27

- Isolate returned projection data from the engine cache so API consumers cannot corrupt later renders by editing category members.
- Check the packaged engine actually used by the CLI instead of loading a second source-tree engine to report availability.
- Add a cache-mutation regression through the standalone package API.

## 1.7.0 — 2026-09-27

- Build a standalone, versioned `@constellation/core` ESM package with its complete dependency closure and WASM. The CLI/Action consumes that package internally.
- Add programmatic config validation, actionable config load failures, and the offline `validate --config` command.
- Add `--dry-run` and JSON `--explain`; expose the same filter report in the studio's summary data.

## 1.6.3 — 2026-09-27

- Clarify refinement limits, off-ring reservations, and the distinction between dragging locks and saved manual placements.
- Browser regressions verify focus, button labels, Enter/Space activation and Escape on every displayed sample node, plus visible keyboard focus.
- Test documented refinement defaults and intensity endpoints.

## 1.6.2 — 2026-09-27

- Cache collision rectangles inside Rust refinement and update them only when a pair moves, preserving candidate order and costs.
- Add `node scripts/benchmark-refinement.mjs`: uncached WASM timings for 64, 128 and 256 nodes, with snapping on/off and determinism checks. Timings depend on the host; use the same host for comparisons.

## 1.6.1 — 2026-09-27

- Reserve ring anchors for locked pairs as well as hidden nodes when their saved position is off-ring. This also protects pairs pinned by hidden labels.
- Skip assignment to fixed JavaScript nodes and labels entirely, preserving read-only objects and exact saved values.
- Regression coverage: off-ring locked anchor reservations and frozen fixed pairs.

## 1.6.0 — 2026-09-27

- Ship the existing deterministic Rust/WASM refinement pass and studio toggle with intensity 0–10. Manual and hidden node/label pairs remain fixed; ring snapping constrains candidates. Settings survive JSON, share links, SVG and workflow generation.
- Give keyboard-selected studio nodes an explicit focus outline, including when glow is disabled. Node buttons support Enter, Space, Escape and Shift-selection.
- Report omitted labels and their reasons in the studio filter summary. Rendering callers can receive `label-omitted` diagnostics through the fourth argument's `onDiagnostic` callback without changing SVG output.
- Retain default SVG output when refinement is disabled.

- Repair story rendering so the displayed and exported SVG is the bounded candidate that Graph Quality scored; manual presentation controls now suspend automatic story selection. Share representative selection across story views and cap Journey across three time periods. Add a direct Profile Story SVG export.
