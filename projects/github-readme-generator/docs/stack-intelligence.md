# Stack Intelligence

Open **README audit**, load a public account, select repositories, and check **Allow read-only manifest analysis for this session**. Then choose **Analyze selected manifests**. Loading repositories or auditing READMEs does not trigger manifest reads. Closing the workspace resets consent; completed evidence remains in this tab.

Results are titled **Detected in selected repositories**. They describe declarations in repository files, not developer skill, proficiency, runtime usage or a complete resolved dependency graph. Each result identifies its repository, observed branch/time, manifest, ecosystem, dependency role and [confidence basis](#provenance-confidence-and-staleness). TOML and line-based declarations include source lines.

## Initial scope

| Ecosystem | Root files                       | Evidence                                                                                                                   |
| --------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Node      | package.json                     | Runtime, development, peer and optional declarations, including npm aliases                                                |
| Rust      | Cargo.toml                       | Direct runtime, development, build and optional declarations, including same-file workspace inheritance and renamed crates |
| Python    | pyproject.toml, requirements.txt | Project/optional dependencies, build requirements, dependency groups and Poetry declarations; named requirements           |
| Go        | go.mod                           | Direct require declarations; indirect entries are excluded                                                                 |

A manifest's presence is evidence of configuration for that ecosystem, not proof its dependencies are used. Unused workspace declarations are excluded; referenced same-file workspace values are resolved without fetching member manifests. Unresolved references are omitted with a notice. Build dependencies are labeled accordingly. The same dependency can appear in multiple roles.

By default only allowlisted regular root files are read. Nested projects and Workspace members are read only with [Nested discovery](#nested-discovery-monorepos). Local `path =` dependencies, include files, lockfiles and transitive resolution are never followed. Symlinks/submodules and oversized files produce notices. Analysis may still miss technologies in executable configuration.

## Nested discovery (monorepos)

Check **Include nested manifests (monorepo)** after **Allow read-only manifest analysis for this session**. It is a second, session-only consent: it starts unchecked, can only be checked while manifest consent is checked, and resets with that consent when you withdraw it or close the audit. Without it, analysis is exactly the root-only behaviour described above, with the same requests.

With Nested discovery on, each repository is read like this:

1. One commits request for the default branch head and one recursive tree listing (the same read used by Evidence snapshots). The tree replaces the root contents listing.
2. Root Manifests found in the tree, each read through the contents API with the usual checks (regular file, at most 256 KB, no symlink target or submodule, exact size and UTF-8).
3. `pnpm-workspace.yaml` and `go.work`, only if they are in the tree. They are Workspace declaration files, never Manifests.
4. Up to 15 nested Manifests, read the same way.

Every Manifest below the root belongs to a **Project boundary**: its directory. A boundary named by a Workspace declaration is a **Workspace member**; any other is a **Nested project**, shown separately because it may be an example or a tool rather than part of the product. Workspace declarations are read as data from root files only:

| File                  | Declaration                                            |
| --------------------- | ------------------------------------------------------ |
| `package.json`        | `workspaces` as an array or as `{ "packages": [...] }` |
| `pnpm-workspace.yaml` | `packages:` as a list of plain or quoted strings       |
| `Cargo.toml`          | `[workspace] members` and `exclude`                    |
| `go.work`             | `use ./dir` and `use ( ... )` blocks                   |
| `pyproject.toml`      | `[tool.uv.workspace] members` and `exclude`            |

Patterns support literal segments, `*` for one directory segment (or any characters inside one segment, as in `apps/app-*`), `**` for any depth and a leading `!` for negation. Repeated `**` segments count as one, and matching takes bounded time for any pattern. Anything else (`?`, `[]`, `{}`, `..`, absolute paths or backslashes) is reported as "Workspace pattern not interpreted" and maps nothing; matching Manifests are still discovered and shown as Nested projects. Other YAML in the `packages:` list is reported, not guessed. A declaration never adds a path that is not in the tree: a declared member that is missing, a symlink or a submodule is reported and never fetched.

### Discovery limits

- Manifest names are the five registry names only.
- At most four directory levels below the root.
- Directories named `node_modules`, `vendor`, `dist`, `build`, `out`, `target`, `testdata`, `fixtures`, `__fixtures__` or `third_party`, and any directory starting with `.`, are skipped.
- At most 15 nested Manifests are read per repository: Workspace members first, then Nested projects, each ordered by depth and then path.
- At most 25 repositories per nested run. With more selected, the scan does not start and the status explains why; nothing is truncated silently.
- Paths with empty, `.` or `..` segments (also percent-encoded), backslashes, control characters, a leading `/` or more than 300 characters are rejected. Symlinks (mode `120000`) and submodules are skipped with a notice. A nested Manifest whose tree entry is over 256 KB, or has no valid size, is listed as not read without a request. Each path segment is encoded when requested.

A Manifest beyond a limit is listed as found but not read, never as absent. Hitting the read cap or the depth limit makes the result partial. If GitHub truncates the tree, the result is partial, root Manifests and Workspace declaration files are found through the root contents listing instead (the truncated tree may not list them), and nested Manifests not listed are unknown. If the tree cannot be read, Studio falls back to the root contents listing, reads root Manifests only and marks the result partial. A branch head that cannot be read fails the repository as before; rate-limit and forbidden responses stop the scan.

**Request budget:** at most 24 requests per repository (head, tree, five root Manifests, two Workspace declaration files and 15 nested Manifests). The budget is counted: when a truncated tree also needs the root listing, at most 14 nested Manifests are read and the result says so. Every file is read at the head commit the tree came from, so the record describes one commit. Root-only analysis keeps its budget of one listing plus five Manifests.

### Results

Each repository's details list **Project boundaries** after the observed line: the repository root, then "Workspace members (declared by …)", then "Nested projects (not declared by a workspace)". Each boundary shows its Manifests, whether each was read, and its dependency count. A summary reads "N manifests found, M read, K not read", followed by the paths not read and why. Dependencies are grouped by boundary; the same package in two boundaries stays two records. Evidence and Stack DNA name the full Manifest path, for example `packages/web/package.json`.

Stack-to-README suggestions still come from root Manifests only; per-project commands are not offered yet. Their evidence names each Confidence basis. A technology with only conditional or ambiguous evidence is never part of the Detected stack section and gets no badge suggestion; it is offered separately as "Technologies with only uncertain evidence" with a caveat.

## Provenance, confidence and staleness

Every Declaration in the results carries its **Provenance**: the repository, branch, Project boundary, full Manifest path, the file's blob SHA, the section and the line when the format has one, and **Observed at**, the time Studio read the file from GitHub. Observed at is not the time the file last changed. A cached result keeps the time it was first observed, never the time the cache was hit. Each dependency line reads `Manifest path · section · line N · basis: <basis> · observed <time> on <branch> · blob <7 characters>`, The full blob SHA is screen-reader text and the tooltip. Engine declarations such as `engines.node` carry the same Provenance.

Each Declaration has one **Confidence basis**, assigned by a fixed rule from the parser's own facts. It is a named reason, never a number, percentage or ranking, and it says nothing about anyone's skill:

| Basis       | When                                                                                                                                                                                                                   | Explanation shown                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| explicit    | `package.json` dependencies and devDependencies; Cargo `[dependencies]` and `[dev-dependencies]`; `project.dependencies`; `dependency-groups`; Poetry dependencies except `optional = true`; `go.mod` require; engines | Stated directly in a supported dependency field of this manifest.                                                                                |
| inherited   | Cargo `workspace = true`, resolved from `[workspace.dependencies]` in the same file                                                                                                                                    | Declared with workspace = true and resolved from [workspace.dependencies] in the same file.                                                      |
| conditional | Optional, peer and build kinds (including `build-system.requires` and optional dependency groups), Poetry `optional = true`, any Cargo `target.*` table                                                                | Optional, peer, build or target-specific, so it may not be active in every build or install.                                                     |
| ambiguous   | Every `requirements.txt` line, and npm aliases (`npm:` values)                                                                                                                                                         | The file cannot tell a direct entry from a generated or aliased one (requirements files may be freeze output; npm aliases name another package). |

When more than one rule applies, the most uncertain wins: ambiguous, then conditional, then inherited, then explicit. A file outside the five registry names would be ambiguous.

Each repository's details list **Uncertain stack results (N)**: conditional and ambiguous Declarations with their explanation, and every Manifest that was found but not read (failed, stopped or over a Discovery limit) as "Not read — unknown" with its reason. The count includes Manifests beyond the listed paths (the not-read list is bounded), so it matches the discovery summary; those show as "N more manifests not read and not listed — unknown". A Manifest that was not read is never reported as absent. Uncertain Declarations also stay in place in the dependency list; nothing is hidden or promoted. Failed records contribute nothing.

A result is **Stale** when the currently loaded repository list reports a newer push (`pushed_at`) than the `pushed_at` the scan started from, or when it was observed more than 24 hours ago. Staleness is worked out each time the results are shown, from data Studio already holds: there are no timers, refetches or per-file commit requests. A Stale result shows the badge "Stale: repository pushed after this scan" or "Stale: observed more than 24 hours ago", and its summary line ends with "Stale" for screen readers. Stale is a reason to refresh, not a claim that anything changed; a push may not have touched any Manifest. To refresh, check **Fetch fresh manifests** and choose **Analyze selected manifests**. Loading the repository list again (it is cached for five minutes) updates the `pushed_at` that staleness compares against. Both push times come from GitHub, so a wrong local clock cannot mark a fresh result Stale or hide a push; only a result without a scan-time `pushed_at` compares with Observed at.

Provenance, bases and staleness are session-only, like the rest of the results: no history, no comparison between scans and nothing in backups or portable projects.

Out of scope: Bazel, Nx, Turbo and Lerna configuration, lockfile-based membership, following local `path =` dependencies, mapping across repositories and running any workspace tool.

The conservative TOML declaration reader supports common quoted keys, arrays, inline tables and dependency tables. It is not a general TOML validator. Unsupported dependency values are reported rather than evaluated; unrelated tool configuration is ignored. Multiline dependency strings, Python dynamic dependencies/group includes, requirements options/continuations and Go replacement/exclusion resolution have explicit limitations. Missing detections do not prove a technology is absent.

The adapters follow the declaration models documented by [Cargo](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html), [Python packaging](https://packaging.python.org/en/latest/specifications/pyproject-toml/) and [Go modules](https://go.dev/ref/mod).

## Normalized dependency records (1.3.1)

Each direct declaration produces a record containing name, ecosystem (node/rust/python/go), kind (runtime/development/peer/build/optional), repository and source evidence. Names normalize to lowercase for npm and to lowercase with collapsed dash/underscore/dot runs for Python. Rust crate spelling and case-sensitive Go module paths are preserved. GitHub repository association uses canonical lowercase owner/repository.

Matching name/ecosystem/kind/repository records merge their manifest/section/line evidence. Different kinds and repositories remain independent. npm aliases and Cargo renamed dependencies use the declared package name, retaining alias evidence. Results have deterministic ordering and share the existing session cache.

“Direct” means explicitly declared by the inspected root manifest; it does not mean verified production usage. Go indirect entries are excluded. requirements.txt has no universal direct/transitive distinction: explicit lines are retained, and generated freeze files may contain transitive packages. No graph or lockfile is traversed to guess that distinction. Optional/target-specific dependencies may not run in every build.

## Security and privacy

Manifest analysis reads data only. It never installs dependencies, executes package scripts, runs repository code or invokes build tools. It never executes setup.py, build scripts, shell commands or TOML/JSON values. It does not follow package download URLs or contact package registries.

Requests go directly to the [GitHub repository contents API](https://docs.github.com/en/rest/repos/contents) for public files on the selected default branch. README Studio does not proxy requests or send draft content. Source is parsed locally and discarded; normalized evidence is escaped when displayed. No detection automatically becomes a profile skill, badge, README edit or project-type override.

## Limits and recovery

Scans use at most three concurrent repository workers, with sequential reads inside each worker. Each repository needs one root listing plus at most five manifests, or at most 24 requests with Nested discovery. Files are limited to 256 KB; each repository retains at most 200 declarations. Up to 1,000 selected repositories are accepted, with result navigation in groups of 25 and lazy detail rendering.

GitHub's unauthenticated rate limit can stop larger scans. Partial results retain successfully read manifests and explain failures; unreadable files are not treated as absent. Cancel stops pending requests. Use **Fetch fresh manifests** to bypass the five-minute cache after resolving a failure. Rate-limit cooldowns still apply.

The normalized cache is bounded to 128 repositories / approximately 2 MB. Results are session-only and are not included in workspace backups. Offline reads fail gracefully; already displayed evidence and existing drafts remain available. Scans observe files as returned by GitHub, not an atomic repository snapshot.

## Development

Pure adapters live in src/stack-intelligence/manifests.js, the bounded declaration reader in toml.js, pure Nested discovery (workspace patterns, path safety and limits) in discovery.js, and GitHub orchestration/cache in client.js. Tests use static manifest strings and mocked HTTP responses; none execute scanned repository code.

## Stack DNA (1.3.2)

[Stack DNA](stack-dna.md) adds a curated technology summary above repository dependency results. Exact ecosystem/package mappings produce categories; unknown packages remain explicit. Existing primary-language metadata and explicit package.json engine declarations provide labeled language/runtime evidence without additional requests. Categories are separate from dependency kinds and developer proficiency.

## Stack-to-README (1.9.11)

[Stack-to-README](stack-to-readme.md) offers evidence-backed suggestions from each expanded result. Allowlisted manager/package identifiers and test/build script presence stay in session evidence; script bodies are discarded. Nothing is inserted until individual selection, per-item Confirmation, source review and explicit whole-diff approval. Editing an item clears its Confirmation. Existing source and builder blocks remain intact, and Provenance stays in the review rather than the draft.
