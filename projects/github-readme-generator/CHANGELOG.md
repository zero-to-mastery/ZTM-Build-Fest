# Changelog

## 1.9.28

- Add versioned localized document metadata with manual locale selection, explicit repository paths, source-edition links, collision refusal, exact Markdown preservation, and backup/project round trips (#201, #228, #229).
- Add bounded exact-revision translation review that distinguishes changed, added, removed, reordered, unchanged, and ambiguous source sections; acknowledgement updates metadata only and rejects stale reviews (#202, #230, #231).
- Add an eight-language fixture corpus and a local uncertainty UI that keeps structural checks available while labeling unsupported English wording heuristics Unknown for non-English editions (#188, #203, #232, #233).

## 1.9.27

- Add optional, skippable Profile, CLI, Library, API, and Game writing lessons that distinguish observed, not-detected, and unknown heading evidence and open the real editor without inserting text (#198, #222, #223).
- Add synthetic setup, usage, and troubleshooting before/after examples with explicit placeholders and annotations so guidance never invents project facts or changes README source (#199, #224, #225).
- Add bounded, content-free per-document checklist progress, safe storage recovery, and ordinary Markdown export without lock-in (#187, #200, #226, #227).

## 1.9.26

- Add explicit same-repository documentation-PR discovery and selection, with exact head recheck, stale/closed/conflicting PR refusal and no unreviewed file-write path (#195, #196, #216–#219).
- Add reviewed draft-PR creation after a separately approved branch commit, enforcing optional least-privilege Pull requests permission, exact head/base SHAs and duplicate prevention (#186).
- Add a content-free PR operation journal and exact reconciliation across all PR states so uncertain responses are never blindly retried; denied permissions and branch changes preserve local exports and source (#197, #220, #221).

## 1.9.25

- Add local audience perspectives for end users, recruiters, contributors and maintainers using evidence and caveats rather than fabricated quality scores (#192, #210, #211).
- Add conservative, source-slice H2 ordering proposals with ambiguous-structure refusal, exact diff approval, stale-draft rejection and Undo (#193, #212, #213).
- Add first-visit checklists for game, CLI, library and API READMEs that keep observed, not-detected and unknown results distinct (#194, #214, #215).
- Cache the lazy Audience review for first use offline and cover source preservation, keyboard-accessible review, 320px reflow and Chromium/Firefox/WebKit behavior (#185).

## 1.9.24

- Add a versioned release acceptance matrix and commit-bound CI evidence artifact covering build, dependency security, recovery and browser gates without converting unrun human checks into passes (#110, #180, #181).
- Document and certify quota, unreadable-storage, crash/reload, offline export and failed update-save recovery behavior (#109, #178, #179).
- Add an explicitly opted-in local feedback export with allowlisted aggregate fields, bounded redaction, review-before-download, no network request and no persistent telemetry (#111, #182, #183).

## 1.9.23

- Advance portable snippet packs to version 2 while migrating version-1 fixtures without changing reusable source and rejecting unknown future versions (#106, #172, #173).
- Add bounded, declarative extension manifests with allowlisted inert capabilities and existing component rendering; scripts, modules, handlers, active markup and unsafe URL schemes are rejected rather than evaluated (#107, #174, #175).
- Add a pre-import trust review for provenance, publisher claims, capabilities and external URLs. Extension imports work offline, leave draft Markdown unchanged and reject hostile manifests before reusable state changes (#108, #176, #177).
- Update the preview sanitizer and development toolchain to patched releases; the release dependency audit reports no known vulnerabilities.
- Load snippet-pack tooling on demand, keeping the main application within its existing release bundle budget.

## 1.9.22

- Certify edit, audit, import, export and optional publishing keyboard/focus/status contracts for Story #103 and tasks #166/#167, with a documented manual assistive-technology acceptance protocol and explicit limits on automated evidence.
- Certify bounded large-document behavior for Story #104 and tasks #168/#169: 100 KB–1 MB analysis/round-trip smoke coverage, measured 100/250 KB browser journeys, latest-only Worker scheduling, cancellation/termination, bounded results/history and exact-source persistence.
- Certify branded Chrome, Playwright Chromium, Firefox and WebKit coverage for Story #105 and tasks #170/#171, including 320 CSS-pixel zoom-equivalent reflow, light/dark contrast assertions, reduced motion, focus visibility and release CI across all engines.

## 1.9.21

- Certify evidence-scoped optional writing across Story #100 and tasks #160/#161: prompts limit factual support to approved Original, notes and selected context; a fail-safe local response check names the provenance and flags every statement not found within one approved source, including contradictions and cross-source recombinations; proposals remain inert until exact diff approval.
- Certify provider-independent behavior across Story #101 and tasks #162/#163 with a direct compatible/local adapter conformance matrix, bounded complete-text parsing, predictable malformed/unavailable-provider errors and offline manual mode.
- Certify consent and data minimization across Story #102 and tasks #164/#165: the UI shows destination and exact messages, sends only after consent, keeps keys in tab memory, clears credentials/consent on provider changes, and clears credentials plus outbound review state on explicit cancellation/close without changing README Source.

## 1.9.20

- Add a deterministic version-1 asset manifest for generated banner SVG packages, with stable ordering, byte sizes, media types, roles, content fingerprints and the exact exported Markdown references (#96, #152).
- Validate visible relative package paths, reject traversal and duplicate destinations, and require every packaged file to appear in the exported references (#153).
- Generate local downloads and optional reviewed GitHub publishing from the same normalized banner package while preserving README Source and keeping every remote write opt-in.

## 1.9.19

- Add a live Banner Builder accessibility review for meaningful alt text and light/dark primary, accent/title and muted-metadata contrast, with concise screen-reader status updates (#95, #150).
- Flag empty alt text and generic labels such as `image`, `banner`, or `screenshot` while leaving all guidance advisory and preserving exact README Source.
- Evaluate banner text colors against a conservative 4.5:1 target, report invalid/incomplete color input safely, and state the limits of the estimate instead of presenting it as WCAG certification.
- Confirm generated SVG banners are static and exercise both operating-system and persistent in-app reduced-motion preferences across preview and reload (#151).

## 1.9.18

- Deliver editable local themes, banner presets and combined brand kits for Story #94 and tasks #148/#149, with reviewed application, versioned JSON portability, backup/recovery and no silent README or remote writes.
- Name combined palette, badge, heading/divider, deterministic banner-visual and optional safe logo-reference tokens as portable version-2 `readme-studio-brand-kit` files. Version-2 visual packs prevent older readers from silently dropping logos; version-1 packs and legacy `readme-studio-visual-preset` files migrate explicitly without logo data.
- Add a full before/after brand-kit token review with post-review edit invalidation and stale-state protection. Reject empty, unsafe or oversized logo references; failed saves leave the prior library intact.
- Let creators review and copy ordinary light/dark logo picture markup from a saved kit without changing README Source.
- Keep identity text, README prose, generated assets, CSS, SVG, HTML, scripts and event handlers outside brand-kit files. Existing 2 MB/100-entry limits, collision handling and explicit reset confirmation remain in force.

## 1.9.17

- Add a migration-safe version-2 batch progress journal with a 500-event limit and allowlisted opened/reviewed/skipped/pending records (#91, #146). Journal entries contain document identity, target identity and exact local source fingerprints where needed, never README content or credentials.
- Show a local Recovery review that classifies every batch item as matching, changed, missing, target-changed or not yet opened. Opening this review makes no request and never edits or publishes content.
- Persist a fresh checkpoint after each successful one-at-a-time open, including partial runs, while leaving failed items pending and preserving all previously opened exact source.
- Add migration, bounds, sanitization, exact-line-ending, backup, reload, offline interruption and no-publish regression coverage (#147). Remote publishing remains a separate single-document reviewed action and is never replayed.

## 1.9.16

- Certify the existing bounded multi-repository review queue against Story #90 and task #144: at most 200 repository targets, one-at-a-time read-only source opening, local progress, explicit reviewed/skip decisions and no batch publishing.
- Certify per-target common-section staging against task #145: every affected README has an exact before/after diff, recipients remain editable after preview, selection changes invalidate approval, and Apply requires a fresh explicit approval.
- Add direct regression evidence that an excluded recipient may change after preview without blocking selected work, remains byte-for-byte unchanged by Apply, and a stale selected recipient fails the entire local write before mutation.
- Retain the prior v1.5.3 implementation and public format unchanged; this release closes its outstanding roadmap trackers with current cross-browser evidence.

## 1.9.15

- Add named, opt-in repository worksets under Save for grouping up to 100 canonical repository identities per set, with at most 50 sets in a workspace (#89, #142).
- Resolve each workset against current document targets at view time, list every matching local document, and show missing repositories explicitly without fetching or changing source.
- Add reviewed, 250 KB-bounded portable workset export/import with a version-1 allowlisted schema, legacy version-0 migration, deterministic duplicate-name handling and no credential fields (#143).
- Include worksets in all-drafts backup, recovery and explicit merge/replace restore while leaving Studio projects, README exports and GitHub publishing unchanged. Add unit and minimum-width browser coverage for bounds, migrations, missing repositories, exact portability and zero network requests.

## 1.9.14

- Add explicit Verified, User-confirmed and Placeholder provenance to every structured documentation command/code field and Code Sample block (#88, #140). New fields default to Placeholder; Verified requires a bounded local note, edits reset stale claims, and existing/imported examples are never run or silently reclassified.
- Export inert portable status comments with content fingerprints immediately before code fences while keeping verification notes in local block metadata. Copying builder output and README export preserve the exact marker and example source; raw content edits make older claims stale.
- Inspect fenced examples and adjacent provenance markers across ordinary Markdown, blockquotes and lists before whole-document, form and block Copy or Export (#141). Placeholder, unclassified, stale, unbound, orphaned, duplicated, invalid or truncated results open a read-only review; continuing preserves exact Source and stale reviews fail closed.
- Add source-inertness, invalid/bounded marker, stale review, keyboard focus, exact copy/download and cross-browser coverage.

## 1.9.13

- Add a byte-bounded, local multi-document resolver for relative Markdown/HTML links and GitHub-style heading or exact-case explicit HTML anchors (#87, #138). Suite paths form a local namespace; validated repository-document targets are isolated by canonical repository and exact branch. Pathless local documents are named as not checked.
- Report missing and ambiguous documents, missing anchors, invalid encoding and paths above the workspace root. Moved filenames are re-evaluated from current metadata, while external URLs, images and fenced examples stay out of scope (#139).
- Run the current document's check before export. Unresolved or truncated navigation opens a read-only report and requires an explicit export-unchanged choice guarded from check start by the active document and fresh snapshots of the checked workspace; no link is fetched, edited or persisted.
- Add source-preservation, stale-review, moved-path, failure, bounds, mobile, offline and Chromium/Firefox/WebKit coverage.

## 1.9.12

- Add typed Documentation suite templates for generic projects, CLIs, APIs, libraries/packages, games and web apps (#86, #136). Every option has a fixed path, a relevance reason and generic editable guidance; no file starts selected and no command, contact address or project fact is invented.
- Add a guided suite flow under Documents with an exact review of every selected path and complete starting Markdown. Editing a choice or source invalidates review, and a separate whole-suite approval is required (#137).
- Revalidate manifests and workspace state at creation, refuse duplicate paths and capacity conflicts, then persist the entire candidate batch before changing in-memory state. Failures create nothing and preserve all existing source.
- Keep every created file as an independent local document with intended-path metadata. Suite creation makes no network request and never publishes; add unit, mobile and cross-browser browser coverage.

## 1.9.11

- Complete the evidence-to-documentation workflow by requiring an explicit per-item Confirmation for every selected Command suggestion and Technology claim before exact-diff review is available (#85, #134).
- Clear an item's Confirmation whenever its editable Markdown changes, while retaining the separate whole-diff approval and stale-draft refusal. Nothing is selected or confirmed automatically.
- Keep full applicable Provenance—repository, Project boundary, Manifest path and section/line, branch, observation time, file revision and Confidence basis—visible during review but out of inserted Custom Markdown blocks, draft metadata, backups and portable projects. Existing source and owned blocks remain unchanged; Undo restores the prior draft.
- Add hallucination, confirmation-invalidation, inert-Markdown, stale-source, mobile and cross-browser coverage (#135). Suggested commands remain fixed, evidence-bounded documentation text and are never executed.

## 1.9.10

- Add explicit, local Audit snapshots for the successful results already on screen (#82, #128). Capture makes no request and stores only canonical repositories, observation revisions/times, states, project-type identity, structured check coverage and finding identities—never README source, evidence prose or decisions.
- Keep snapshots in the separate `readme-studio:audit-snapshots:v1` key with five per account, 20 total, 1,000 repositories and 60 findings per snapshot entry, 20 unavailable URLs per repository and a two-million-character envelope. Another account is never evicted; deletion, rejected-write safety and damaged-data recovery are explicit.
- Compare two captures as Added, Resolved or Unknown only when both observations are safely comparable (#129). Repositories must have been assessed twice and re-read under the same rules and project type; history and link findings additionally require their respective checks in both captures.
- Add cross-browser capture/diff/delete coverage and stale, partial-check, retention and recovery unit coverage. The interface explicitly says snapshots are not live monitoring.

## 1.9.9

- Persist Manual project types per canonical repository and continue applying them after reloads, account switches and README revisions (#81, #126).
- Persist Dismissals against the observed README revision; changed revisions surface the saved choice as stale instead of silently hiding fresh evidence. Automatic and Restore explicitly remove their respective decisions.
- Store decisions in `readme-studio:audit-decisions:v1`, migrate valid legacy attention preferences in memory on first write, and never rewrite or delete the old key. Damaged new or legacy data stays downloadable and blocks writes until an explicit start-fresh action (#127).
- Add repository-scoped reset, rejected-write safety, migration/recovery unit coverage and cross-browser reload/revision coverage.

## 1.9.8

- Complete the Round-trip corpus with SHA-256-pinned Studio-project fixtures for raw source and mixed builder/Custom Markdown/component ownership (#79, #122).
- Verify exact Markdown, Block order and types, Seams, component metadata, workspace preferences and project/workspace re-exports. The corpus refuses unlisted or changed fixture bytes instead of silently accepting normalized output.
- Keep `npm run test:round-trip` as an early, named CI release gate on pull requests, `main` and version tags. It covers the full pinned corpus plus deterministic seeded single-range edits (#123).

## 1.9.7

- Add Ownership review for stale builder and component saves (#78, #120). Current Markdown, the proposed visual version and a unified diff are shown before anything can replace source changed after the form opened.
- Make **Keep my Markdown** the focused default and Escape outcome. **Use visual version** rechecks the whole draft, refreshes a stale comparison instead of applying it, and replaces only the reviewed Block in one Undoable edit.
- Mark Restorable Detachments in the Sections list and offer their saved builder/component version for explicit review. Applying preserves the current Seam and clears only that Detachment record; non-Restorable, malformed, missing and duplicate-identity records cannot restore.
- Add unit and cross-browser-ready browser coverage for Restorable records, concurrent raw edits, stale review refresh, builder/component conflicts, Undo and safe refusal paths (#121).

## 1.9.6

- Add a machine-local, content-free Publish journal before the first remote write (#99, #158). It records the exact target, change set id, Base/Result SHAs, byte counts and per-file outcomes without storing README, asset or workflow content.
- Treat a lost or unreadable write response as `unknown`, stop the attempt, and require explicit Reconciliation reads before any retry. Result SHA means written, Base SHA or absence means not written, and any third state is diverged and requires a fresh review.
- Allow retry only in the same open review, only for files reconciled as not written, and only after a new explicit approval (#159). A reload retains enough metadata to reconcile but intentionally cannot replay content.
- Have the server refuse an already-applied Result SHA before PUT, and distinguish ambiguous 5xx/lost PUT responses from definitive refusals. Malformed journal data is preserved, blocks publishing, and must be downloaded before explicit clearing.
- Add injected lost-response, idempotency, partial-state, malformed-storage and browser recovery coverage; local Markdown, builder state, portable projects and backups remain unchanged.

## 1.9.5

- Make raw Markdown edits source-preserving (#77, #118): only the Blocks and Seams an edit touches change, while every byte outside that scope—including CRLF, BOM, trailing whitespace, fenced code and raw HTML—stays identical. Untouched builder, component, generated, shared, profile and banner Blocks keep visual ownership.
- Turn each touched Owned block into exact Custom Markdown and add a visible, bounded Detachment record. Keyboard typing, multi-range reviewed changes and moved-plus-edited sections follow the same rules; Undo restores the prior draft in one step.
- Keep Detachment records with autosave, workspace backups and Studio projects without placing them in exported Markdown. Portable files use explicit metadata field allowlists and omit removed labels, generated text/options, profile text, detached banner settings and generated banner assets.
- Add a named byte-level round-trip CI gate (#119) with SHA-256-pinned CRLF, mixed-EOL, BOM, no-final-newline, trailing-whitespace, fenced-code and raw-HTML fixtures; exact Studio-project/workspace round trips; and deterministic seeded edit cases.
- Preserve blank lines typed before a builder section when its form is saved, and document source ownership, Detachment, portable-data privacy and the round-trip contract.

## 1.9.4

- Add a reviewed change-set manifest before every GitHub publish (#98, #156). The review identifies the exact owner, repository, branch and checked head commit, then lists every README, asset and workflow write with its action, path, Base SHA, Result SHA and unified diff.
- Require explicit approval of the exact manifest before publishing (#157). Changing Markdown, generated files, the target or any reviewed input withdraws approval; closing and reopening the dialog also starts unapproved.
- Have the client reject tampered, duplicated or incomplete manifests, then re-read every existing file immediately before writing and refuse stale, missing or unexpectedly present files. For each submitted write, the publishing server independently validates its expected Base SHA and recomputes its Result SHA.
- Keep writes non-destructive: no force updates, deletes or ref rewrites, and no automatic retry after partial failure. A partial result identifies which files were written and requires a fresh review against GitHub's new state.
- Add unit and browser coverage for exact manifests, changed targets, stale reviews, tampering, offline and partial-failure cases, plus updated publishing, architecture and security documentation.

## 1.9.3

- Add an evidence-backed Improvement plan to every assessed repository in the audit and README Attention Queue (#80, #124). Each Recommendation comes from one observed finding, cites the README revision and observation/check time, explains project-type applicability and never invents replacement content, commands, links or facts.
- Group Recommendations into descriptive **Start here**, **Next** and **Optional** bands instead of scores. Missing/thin READMEs, starter text and placeholders lead; key type-specific gaps and unavailable links/images follow; other topics and README-history review remain optional. Plans are deterministic and capped at 30 items.
- Fold a missing or stub README into one Recommendation with relevant sections to consider, instead of flooding the plan with one item per topic. Weak project-type inference, likely non-English headings, public APIs, documentation links and Experiments receive explicit conservative caveats.
- Add reviewed actions for every Recommendation: Improve README, Open in Studio, Open README on GitHub, session-only Skip and revision-bound session-only Dismiss (#125). Missing/thin README findings use the existing Mark intentionally minimal decision instead of Dismiss.
- Keep audit decisions local and non-destructive. Skip and Dismiss make no request, change no Markdown and publish nothing; stale dismissals return when the observed README revision changes or becomes unknown, with explicit re-dismiss/forget controls.
- Add keyboard, mobile, offline, focus-management, empty/failure-state and type-specific false-positive coverage, plus user documentation and a synthetic Improvement plan screenshot.

## 1.9.2

- Stack Intelligence shows the Provenance of every detected declaration (#84, #132): Manifest path, section, line, branch, shortened blob SHA and when it was observed. The full blob SHA is available to screen readers. A cached result keeps its original Observed at.
- Each declaration has a named Confidence basis (explicit, inherited, conditional or ambiguous) with one fixed explanation. Bases are never a number or ranking and never describe skill. Poetry dependencies declared `optional = true` are conditional, like Cargo and PEP 621 optional dependencies.
- Each repository result has an "Uncertain stack results (N)" list (#133). It holds conditional and ambiguous declarations with their reason, and manifests that were found but not read, listed as "Not read — unknown". The count includes unread manifests beyond the listed paths, so it matches the discovery summary. Uncertain results still appear in place in the dependency list.
- Results are marked Stale when the loaded repository list shows a newer push than the one the scan started from, or when they were observed more than 24 hours ago. Both push times come from GitHub, so a wrong local clock does not change the result. The text badge points to Fetch fresh manifests, and the summary line includes "Stale". This is worked out when results are shown, with no timers or extra requests.
- Stack DNA evidence shows the same provenance and basis, and labels technologies with only conditional or ambiguous evidence as "only uncertain evidence".
- In Stack-to-README review, each evidence line names its Confidence basis. Technologies with only uncertain evidence are left out of the Detected stack section and get no badge suggestion. They are offered separately, unselected, as "Technologies with only uncertain evidence", with a caveat.
- Stack scan records are now version 5 and session-only. `observedAt` replaces `checkedAt`, which remains as an alias for one release. Records gain `pushedAt`, and dependency evidence items carry full Provenance with a named Confidence basis. The basis explanation is looked up when shown and is not stored with each item.
- The "Found, not read" heading in Project boundaries is now "Not read — unknown".

## 1.9.1

- Add the usability scripts ([docs/usability-scripts.md](docs/usability-scripts.md)) (#76, #116): seven Usability scenarios (N1–N4 novice, E1–E3 experienced). Each has a start state, a success criterion and a step budget. The doc also has a facilitator protocol, consent and privacy statements, and a severity scale. There are no in-app analytics, telemetry or new storage (ADR 0006).
- Add the Friction tracker ([docs/usability-findings.md](docs/usability-findings.md)). Scripted run, heuristic walkthrough and Participant session findings are kept in separate sections. No Participant sessions are recorded yet.
- Add scripted runs (`tests/browser/usability-scenarios.spec.js`) that count author actions in each scenario. They attach a JSON result and fail when a scenario stops completing or goes over the step budget in the scripts doc. The E2 run also fails if any write request reaches GitHub. `tests/usability.test.js` checks that the scripts doc and tracker stay consistent, including findings tables placed under any other heading.
- Guided start offers **Restore a backup** among its other ways to start (#117). It opens the existing restore dialog, which checks the file before anything changes.
- A merge restore of a workspace backup now opens the backup's active draft and says which draft it opened, also when some incoming evidence snapshots did not fit the workspace limit. Every local draft is kept.
- **Export README**, **Copy Markdown**, **Save Studio project**, **Download all drafts backup** and **Download draft backup** no longer silently leave out section edits that have not been saved. They ask first: save the section and continue, continue without the edits, or keep editing. Saving happens only on that choice and Undo reverses it. If the section's fields are invalid, no save is offered and Keep editing returns to the form's fields. If the form closes while the question is open, nothing is saved or exported and a notification says so.

## 1.9.0

- Stack Intelligence can include nested manifests in monorepos (#83). A separate, session-only **Include nested manifests (monorepo)** consent reads one repository tree listing. It maps Manifests to Project boundaries: the repository root, Workspace members (declared by package.json `workspaces`, `pnpm-workspace.yaml`, Cargo `[workspace]`, `go.work` or `[tool.uv.workspace]`) and Nested projects. Results list the boundaries, a "found / read / not read" summary, and dependencies grouped per boundary. Every file is read at the head commit the tree came from.
- Bound Nested discovery (#130): at most 4 directory levels, dependency and build directories skipped, at most 15 nested Manifests read per repository (members first, deterministic order), at most 24 requests per repository and at most 25 repositories per nested run. If more repositories are selected, the scan is refused with an explanation rather than truncated. If GitHub truncates the tree, root Manifests and workspace declaration files are still found through the root listing, within the same 24-request budget.
- Harden discovery against malicious paths, with tests (#131). Traversal, absolute, backslash, percent-encoded dot, control-character and over-long paths are rejected with notices. Symlinks, submodules, missing declared members and nested Manifests over 256 KB are never fetched. Workspace patterns that cannot be interpreted are reported, and matching takes bounded time for any pattern. Contents responses are checked for path, size, target and encoding.
- The stack scan record is now version 4 (session-only). Manifests carry their full `path`, registry `file` and `project`. Dependencies merge per Project boundary. The cache separates nested and root-only results. Root-only analysis keeps its budget of one listing plus five Manifests.

## 1.8.0

- Add the publishing Preflight (#97): an explicit, read-only check of the exact repository, branch and path before any write. It checks the publishing service, GitHub session, GitHub App installation, Contents permission, your push access, archive state, branch existence, path support and, for workflows, server opt-in plus Workflows: write. Branch protection, rulesets and committing to the default branch show as advisory warnings that never block.
- Add a **Re-check access** button and a Preflight check list with written Pass/Warning/Fail/Unknown status and an announced verdict.
- Every publishing review now starts in Read-only mode. The confirmation and publish button appear only after a Preflight for the exact current target passes every blocking check. Changing the target, disconnecting or reloading clears the Preflight, and it is never saved.
- **Load remote README** now runs the Preflight and then the read as one explicit action. A missing branch is reported instead of being loaded as a new file.
- The publishing server enforces the same Preflight checks before every write and refuses with the same message the dialog showed. A 403 or 422 from GitHub at write time now opens **Publish on a new branch instead**. A refusal from the server's own Preflight does not, because branch creation would be refused the same way.
- **Publish on a new branch instead** is offered only when the server would accept it: installation, Contents permission, push access, repository not archived, branch exists and, for workflows, server opt-in plus Workflows: write. Creating a workflow branch again requires the workflow opt-in.
- An offline or failed Preflight leaves every check Unknown and keeps Read-only mode. Nothing is loaded and nothing is retried automatically.
- Before a target is chosen, **Supported path** shows Unknown instead of a misleading Fail.
- Add a manual verification checklist for a real GitHub App (read-only installation, removed Workflows permission, protected branch or ruleset, archived repository) to the publishing guide. These steps are manual and not run by CI.

## 1.7.1

- Add the Next steps panel. After an import (new draft, replace, append, merge or Re-import), a README opened from the audit, a profile or repository template, a Studio project opened as a new draft or a blank start from Guided start, it shows up to three existing tools that usually come next, each with a one-line reason, and one sentence saying what happened (for example "Imported into a new local draft. Nothing changed on GitHub."). **All tools** opens workspace search; **Hide** removes the panel.
- Choose the steps with a pure, deterministic rule from how the document arrived, your goal and cheap facts (section shape, repository target, import source, online state). For example, an imported single Markdown block offers Split into sections, README Health and a Drift check when the document has a target; an audit offers README Health, a Drift check with a target and the README Attention Queue. Offline, GitHub steps are hidden and the panel says so; with blocked storage, or after a save fails (for example storage full), the last step is Export README. Undo and Redo recompute the steps.
- A step only opens its tool through the same action as the visible control, so review, stale-draft checks and Undo stay with the tool. No step edits Markdown, applies a change, fetches or publishes, and choosing steps runs no Health or drift analysis.
- The panel sits above the panes (also on mobile), never takes focus or announces itself (the Arrival's own notification does, including new "template opened" and "Blank draft created." messages), returns focus to a step when the step's dialog closes, and is unreachable while a dialog is open. Hide moves focus to the editor, or to Current draft when the editor is hidden. It is forgotten on Hide, a document switch, a workspace restore, a new Arrival, undoing the import that changed the document, or a reload; it is never stored (ADR 0005).
- Add **Save → Settings → Guidance → Show next steps after imports, audits and templates**, saved as `guide.nextSteps` in the workspace (ADR 0004), included in all-drafts backups and never in Studio projects or exports. Workspace version and project schema stay at 1. No new request, dependency or telemetry.

## 1.7.0

- Add Guided start, the first screen of a new workspace. It asks what you want to do first: **Write my profile README**, **Write a repository README** or **Audit my repository READMEs**, each with a one-line description; the audit says it needs a GitHub connection. Reopen it from **Create → Guided start** or workspace search. A saved workspace never opens it by itself.
- Choosing a goal shows a second step in the same dialog with focus on its heading: profile templates, GitHub autofill or a blank profile README; the repository README builder, README import or a blank repository README; or the README audit. Each option opens the tool's normal flow. **Back** returns to the goals with focus on your choice. Offline, Open README audit stays focusable but is marked unavailable with the reason, and import or a blank repository README are offered instead.
- Keep every earlier Start path under its existing name in **Other ways to start**: Start from a template, Autofill from GitHub, Import GitHub README, Open Studio project, Start blank and Explore the sample profile.
- Show a Locality statement: drafts are saved only in this browser, are not encrypted and can be cleared, so download a backup; GitHub is contacted only when you choose a GitHub action (import, autofill, audit, repository lookup, refresh and link checks, evidence and drift checks, or publishing), link checks also contact the linked sites; analysis runs in the browser and Markdown is sent only when you publish it or review and send text to the optional Writing Assistant's provider; preview images and badges load from their own sites; nothing is published without its own review. With blocked storage it says the workspace is temporary; when the saved workspace cannot be read it points to the untouched original's recovery data instead, and Guided start does not open by itself over the recovery notice.
- Save the goal in a new optional, versioned `guide` workspace field (ADR 0004), included in storage recovery and all-drafts backups (replace restore uses the backup's goal, merge keeps yours) and never in Studio projects, single-draft JSON or README export. Earlier workspaces get no goal; any other `guide` value that is not version 1 (another version, or a malformed value such as `null`, a string or an object without `version`) is kept unchanged and read as no goal if it is up to 1 KB and an all-drafts backup carries it unchanged (within its nesting limit, no credential-named keys); a larger or uncarriable one gets the default. Workspace version and project schema stay at 1. No new request, dependency or telemetry.

## 1.6.2

- Add reviewed drift fixes: after a drift check, **Review fixes** turns observed mismatches and uncertain findings into one proposal per Markdown line, each with its findings' evidence, the current and proposed line, an exact diff and its own approval checkbox. Unknown results and matches are never proposed.
- Suggest a correction only when the evidence supplies one: a path's case-sensitive spelling, a punctuation-only near anchor, a single near script name and the whole `engines.node` minimum (`20.11`, not `20`) for a prose Node version. Other proposals start unchanged for the author to edit; suggestions are placed only on whole-word, whole-path matches, never inside a longer link, path or anchor on the same line (including after a directory link's trailing `/`) or inside another URL's query (`?file=docs/guide.md`). A link's suggestion goes on the line where the link is written (for a reference link, the definition its label uses), never on an earlier prose mention of its path, a code example, an HTML comment or an unused definition, and is withheld when the URL is not written verbatim. Every prose Node statement on a line is updated, in each phrasing the check reads; when the statement has a link in it (`[Node.js](https://nodejs.org) 18 or newer`) or wraps onto a second line, the suggestion goes on its version number. A prose version is compared as far as it is written, so `Node 20.5` is older than `>=20.11` while `Node 20` is not. A finding whose suggestion an identical one on the same line already placed is shown as placed.
- Nothing is approved by default, editing a proposal withdraws its approval and unapproved lines are kept byte for byte, including line endings. Apply refuses any Markdown, document or target change since the check, keeping the manual edit. One Undo step restores the previous Markdown. Applying to a builder draft converts it to one Custom Markdown block; the review says so before Apply and Undo restores builder ownership.
- Applying writes only the local document. No request is made and nothing is published; Publish to GitHub stays a separate reviewed action. Proposals are not saved (ADR 0003).

## 1.6.1

- Add read-only drift checks for documents with a GitHub target: package scripts, lockfiles and package managers, files named in shell commands, inline paths, relative and same-repository GitHub links, heading anchors, Node version statements and `.env` keys are compared with the repository now.
- Report each claim as an observed mismatch, an uncertain finding (inline mentions, fallback-capable commands, generated or ignored paths, ambiguous working directories, prose and near anchors) or unknown when evidence is missing, failed or truncated; unknown is never drift.
- Read at most the tree, the root `package.json`, one `.env` example and ten anchored Markdown files by blob revision, 256 KB each, through the shared public client. Content is parsed as data and discarded; nothing is run, saved or written, and in-document anchors are checked offline without requests.
- Annotate results with what changed since a same-target Baseline. Share the tree reader, relative path resolution and URL walk with evidence snapshot capture.
- Fewer false observed mismatches: interpreter options and their values, extensionless Node.js entry points, version/help commands, files earlier commands may create, other repositories' clones, submodule paths, npm's echoed output in `console` sessions and possible longer branch names are no longer reported as contradictions. Raw HTML headings produce anchors; programs that earlier build, unpack or setup steps may produce, build output folders themselves, `cd <repo-name>` into a same-named folder, `pushd`, subshells, heredoc bodies, settings and prose in untagged fences are no longer observed mismatches, and a missing `.env.example` template is. Absolute links to the document itself use local headings; BOM-prefixed files, HTML entities and commented-out anchors are handled; each linked file is parsed once.

## 1.6.0

- Add explicit, read-only evidence snapshots for documents with a GitHub target: branch head, README revision, recognised root manifests/lockfiles, relatively linked files and a local Markdown fingerprint. Revisions only; no repository file content is stored.
- Save partial snapshots when the tree is unavailable or truncated; unreadable files are unknown, never drift. Head failures, offline use, cancellation and storage failures save nothing and keep existing snapshots.
- Pin one Baseline per document and run a change check that reports unchanged, changed, added, removed and unknown evidence without saving. Snapshots for a changed target are labelled Different target and cannot be compared.
- Bound retention to five snapshots per document plus its Baseline, 100 per workspace. Include snapshots in workspace backup/recovery but not in Studio projects or README exports.
- Merge restore never evicts local snapshots; incoming snapshots that do not fit stay in the backup and are counted. A fresh capture is never dropped by retention, recovery cannot fail on excess Baselines, and draft deletion warns that the document's snapshots go too. Links above the repository root or with undecodable paths are noted instead of mis-recorded or silently dropped.

## 1.5.5

- Suppress the new-version notice on first service-worker installation; offer updates only when a waiting worker can replace an active worker.
- Add regression coverage for first installation and genuine updates, plus a production first-load check across browser engines and hosting paths.

## 1.5.4

- Follow the operating system's light/dark preference by default and respond when it changes.
- Move the app theme override from the header into the editor toolbar; retain the separate README preview theme control.
- Migrate legacy default-light workspaces to system preference while preserving an existing dark preference.

## 1.5.3

- Connect attention-queue Improve next to a persistent local review batch, with explicit reviewed/skip decisions, return-to-pending and next-document navigation.
- Preserve existing workspace edits; open missing local documents using one read-only GitHub request at a time, with cancellation and partial-result recovery.
- Prepare a common Contributing section for explicitly selected repositories, then require shared-component per-document diff review before insertion. No batch publishing action.
- Include review progress in workspace backup/recovery and clarify that local review does not mark remote audit findings resolved.

## 1.5.2

- Add Cross-README updates and a workspace-wide preview of pending shared changes, with affected and selected README counts.
- Select recipients beside each document diff; workspace-wide previews start with none selected. Select all/clear are explicit actions, and every selection change invalidates approval.
- Apply only the chosen preview entries, preserving unselected sources and checking selected document snapshots plus the shared definition before local persistence.

## 1.5.1

- Add versioned shared Markdown definitions for contributing, testing, security, contact, badges and community links, with editable starting examples.
- Preview exact insertion/update diffs for selected documents and require approval before applying. Saving or deleting a definition never changes README source.
- Protect local edits, reject stale reviews, and keep independent document Undo/Redo for reviewed updates. Failed persistence prevents partial document application.
- Include shared definitions and linked copies in workspace backup/recovery; merge collisions remap incoming references without overwriting local definitions.

## 1.5.0

- Add searchable workspace documents grouped into Profile, Repositories and Local documents, with keyboard navigation and a grouped quick switcher.
- Configure an independent repository, branch and README path for each document; publishing suggests that target without skipping review.
- Preserve separate, bounded Undo/Redo histories across document switches in the current tab. Health follows the active document and cancels obsolete work.
- Reopen matching audit documents without replacing local edits; preserve targets and exact sources in workspace recovery and portable projects.

## 1.4.3

- Separate writing provider adapters from document editing and bounded network transport; offer compatible endpoints, key-free loopback servers and explicit no-AI mode.
- Show provider, destination, key policy and transmitted context. Provider changes clear credentials/consent and cancel pending work; manual diff review stays available offline.
- Harden prompts against instructions embedded in imported repository content and reject legacy function-call responses alongside tool calls.
- Strip credential fields from portable project metadata, draft JSON and workspace backups without changing Markdown source. Document prompt-injection boundaries and residual model risks.

## 1.4.2

- Optional comparison mode generates Concise, Technical and Friendly alternatives with distinct style instructions and the same reviewed source/context.
- Side-by-side source cards on desktop, stacked cards on mobile; choosing a version copies it into editable Proposed without changing the draft.
- Exact preview of all three messages and explicit notice of up to three sequential provider requests. Failure/cancellation stops remaining requests and preserves completed versions; no automatic retries.
- Warns when the provider returns identical alternatives. Choosing another version invalidates diff approval; context/action/mode changes clear stale alternatives.
- Explicit long-to-short, paragraph/notes-to-bullets, bullets-to-paragraph and technical-notes-to-README-summary transformations. Existing grounding and diff-reviewed Apply remain mandatory.

## 1.4.1

- Seven explicit, editable writing-context sources: GitHub profile, one selected repository, project type, that repository's Stack DNA, draft project metadata, one selected section and current writing style.
- All sources start unchecked. Allowlisted facts from existing local/session data only; no background fetch, whole-workspace upload or account-wide stack summary.
- Exact outbound message preview includes Original, notes, selected context and grounding instructions. Context changes cancel pending generation and invalidate consent and diff approval.
- Grounding instructions require supplied factual support and omission of unsupported claims. Style samples are not factual evidence; detected technology is not proficiency.
- Context validation and combined request limits fail visibly without silent truncation. Existing Original / Proposed / Diff / Apply and offline manual review remain intact.

## 1.4.0

- Optional Writing Assistant with nine actions: draft section, improve wording, shorten, expand, technical/casual tone, notes to bullets, bullets to paragraph and grammar cleanup.
- Operates on exact selected text, a chosen Markdown section or a new section at the cursor. Only Original and optional notes are sent after explicit consent and Generate.
- Editable Proposed source, Original and full README Diff, explicit approval and Apply. Edits invalidate approval; stale drafts cannot be overwritten. Undo restores source and builder ownership.
- Configurable OpenAI-compatible chat endpoint and model, including local models. Connection settings and keys stay in tab memory and out of storage, drafts and backups.
- Cancel/timeout, bounded inputs/responses, safe error reporting and no automatic retries. Manual proposals and core editing remain usable without AI.

## 1.3.3

- Reviewed stack-to-README suggestions for technology badges, grouped stack sections, package managers, installation, testing/build commands and package/crate links.
- Allowlisted manifest metadata retains recognized manager names, test/build script presence and bounded package identities; script bodies and arbitrary configuration are discarded.
- Every suggestion starts unselected, shows evidence and inference limits, and allows Markdown editing. Exact diff approval is invalidated by edits; stale draft snapshots cannot be overwritten.
- Append-only application preserves existing source, builder ownership and metadata, supports Undo/Redo and autosave, and performs no repository writes or command execution.
- Conventional commands and publication links remain unverified suggestions; remote badge rendering contacts Shields.io. No skill claims, automatic insertion or new dependencies.

## 1.3.2

- Stack DNA workspace summary groups selected repository evidence into meaningful technology categories using a versioned curated catalog.
- Exact ecosystem/package mappings; no AI, substring guessing, skill claims or quality scores. Unmapped dependencies remain Unknown.
- Core combines Language, Framework and Runtime; Data contains Database. All thirteen categories are filterable with keyboard-accessible source evidence.
- Preserves package, dependency kind and repository associations across merged technology identities. GitHub primary-language metadata and explicit runtime engine declarations remain labeled evidence sources.
- Bounded evidence details and summary rendering, deterministic ordering, mobile coverage and no additional network requests or dependencies.

## 1.3.1

- Normalized direct dependency records from package.json, Cargo.toml, pyproject.toml, requirements.txt and go.mod: name, ecosystem, kind and repository association.
- Runtime, development, peer, build and optional kinds remain distinct; matching records merge source evidence across manifests.
- Excludes Go indirect requirements and unused/unresolved Cargo workspace entries; resolves referenced workspace aliases from the same manifest only.
- Session caching retains normalized records with branch/repository isolation, bounded storage and explicit refresh. No installs, code execution or transitive graph resolution.

## 1.3.0

- Opt-in Stack Intelligence within Repository README Audit: read selected public repositories without changing drafts or profiles.
- Root Node, Rust, Python and Go manifests expose declared dependencies with ecosystem, manifest, role and source evidence. Detection is not a developer skill assessment.
- Bounded, cancellable GitHub-only reads, session caching, explicit refresh, partial results and shared rate-limit handling.
- No dependency installation, script execution, repository code execution, package URL following or build-tool invocation.
- Conservative declaration parsing, escaped evidence, keyboard controls, mobile results and documentation of unsupported/dynamic configuration.

## 1.2.3

- Safe UTF-8 file, pasted Markdown and current-draft imports with exact file source preservation.
- Conservative section matching, aliases and related-section guidance; empty headings and badge-only sections are not treated as complete.
- Additive merges preserve the original source. Changed imports and replacements require an exact diff review and approval, invalidated by subsequent edits.
- Optional reviewed context, unchanged-source escape hatch, keyboard review focus and sanitized light/dark previews at narrow widths.
- Repository fixtures and cross-browser regression coverage for source preservation, false positives, review gating and mobile usability.

## 1.2.2

- Project-aware Library recommendations follow the repository template, with a draft-specific manual selector that never rewrites existing sections.
- Structured CLI syntax/commands/flag rows, API endpoint authentication/parameters/request/response examples, and library imports/basic examples/API surface/compatibility.
- Game gameplay, control rows, screenshots, local-running guidance and save/data behavior; Rust Cargo dependency/features/examples and docs.rs/crates.io links.
- Web-app templates combine demo, screenshots, setup, environment, architecture, testing and deployment builders.
- Safe URL validation, required screenshot alt text, literal code fences and portable settings; existing raw content and prior section types remain supported.

## 1.2.1

- Eighteen structured repository documentation builders: Overview, Features, Installation, Quick Start, Usage, Configuration, Environment Variables, Commands, API, Examples, Architecture, Testing, Deployment, Troubleshooting, Contributing, Security, License and Roadmap.
- Installation fields for package manager, command, prerequisites and notes; Testing fields for commands, test types and coverage notes.
- Environment-variable rows with required flags, descriptions, example placeholders, keyboard reorder/duplicate/remove controls and explicit guidance against committing real secrets.
- New repository templates use structured builders for supported sections. Existing source and older Custom Markdown templates are not converted or rewritten.
- Ordinary Markdown serialization, safe command fences/table cells, portable settings, undo/redo and raw-edit source preservation.

## 1.2.0

- First-class repository README builder with 12 templates: Web App, Library, CLI, API, npm Package, Rust Crate, Python Package, Game, Open Source, Tutorial, Documentation and Generic.
- Audit Improve README and queue Improve next preselect the reviewed project type and carry public name, description, homepage, language and topic suggestions.
- Editable suggestions, selectable sections, generated-source preview and explicit new-draft creation; existing README source is preserved by default.
- Unknown setup, usage, compatibility and license information stays as writing prompts, never invented facts. Open in Studio still opens exact original source.
- Separate editable sections, portable reviewed metadata, safe URL/Markdown handling, mobile and cross-browser coverage.

## 1.1.3

- Conservative TODO, project-name and combined framework-template signals, excluding code examples and comments.
- Optional per-repository history/link review using GitHub commit observations and existing link-health checks; unknown/CORS results are not broken links.
- History review requires an old observed README update and sustained recent activity; activity alone never implies stale documentation.
- One bounded retry for transient gateway/network errors, shared GitHub rate-limit cooldown, explicit partial-result counts and retained assessments.
- Synthetic 100/500/1,000-repository coverage, three concurrent README requests, bounded caches and advisory findings in the attention queue.

## 1.1.2

- README Attention Queue with explainable High/Medium/Low priorities from audited documentation, project-type gaps, recent pushes and public-interest signals; no scores or developer rankings.
- Combined priority, missing, active, archived, language, project type, minimum stars and recent-push filters, with bounded 25-item pages.
- Improve next and Open in Studio preserve exact source in a new local draft.
- Seven-day ignore and persistent intentionally-minimal decisions bound to the README revision, with deferred-item review and explicit return to queue.
- Safe attention-settings recovery and visible storage failures; deterministic ordering, 1,000-record, browser, source-preservation and revision-change regression coverage.

## 1.1.1

- Explainable project-type suggestions for 14 types, from public topics, repository names and README prose; ambiguous signals remain visible.
- Per-repository manual overrides, retained in the audit session and applied immediately from cached evidence without additional requests or source changes.
- Type-specific documentation profiles and classifications, including appropriate short experiments. Missing topics are advisory: commonly useful for this project type, never universal requirements.
- Keyboard/mobile controls, Worker/fallback parity and regression coverage for deterministic suggestions, profile evidence and override recovery.

## 1.1.0

- Repository README audit workspace with public owned-repository pagination to 1,000, explicit selection, and fork/archive filters.
- Evidence-based missing/stub/minimal/basic/detailed/documentation-heavy classifications using the existing analyzer; no scores or developer rankings.
- Three concurrent README fetches, bounded session cache, cancel/partial/rate-limit recovery and local Worker analysis with JavaScript fallback.
- Root README verification, repository/source links, and exact-source improvement in a new local draft.
- Classification, 100-repository browser, 1,000-repository pagination, keyboard/mobile and failure-handling coverage.

## 0.9.3

- Feature freeze for 1.0: representative 0.1–0.9 migration and source-recovery regression fixtures.
- Seven fictional, portable example projects with exact README round-trip checks.
- Concise onboarding, task tutorials, public format compatibility policy and documented limitations.
- MIT license, bundled third-party notices and unpublished stable-release notes.

## 0.9.2

- Production offline reload with an explicit static-file cache, credential/API exclusions and save-before-update activation.
- JavaScript fallback when Health/refactor Workers fail; stale fallback work is ignored.
- 500 KB/1 MB source and 100-project/200-badge smoke coverage, 360px keyboard checks and faster duplicate heading anchors.
- Markdown dependency chunk split, bundle reporting and stricter publishing-history recovery.

## 0.9.1

- Versioned portable Studio projects with exact Markdown, supported builder/ownership metadata, preferences and verified SVG asset manifests.
- Explicit save/open review, opt-in reusable libraries, collision-safe new drafts and Markdown-only recovery for future or damaged schemas.
- Deterministic legacy draft migration and authentication-free publishing references.
- Stable block IDs on reload and remapped banner ownership when importing backups.

## 0.9.0

- Grouped task navigation and searchable command palette with keyboard shortcuts and direct section/library destinations.
- Persistent pane, builder, tool-group and accessibility preferences; unified settings, draft context and bounded local activity.
- Shared current/generated source review across imports, refreshes, refactors, assets and GitHub publishing; existing confirmations remain required.
- Browser coverage for command execution, restoration, focus and source preservation.

## 0.8.3

- Consistent Escape and click-outside modal dismissal with unsaved-edit protection and predictable focus return.

- Guided, locally generated workflow YAML for Constellation, Snake, Metrics and user-maintained commands/actions, with source highlighting, attribution, schedules and permission explanations.
- Secret-name placeholders, safe filenames/outputs, basic workflow health checks and corresponding README embeds.
- Workflow publishing requires server opt-in, GitHub App Workflows permission, generated-source validation, diff review and SHA conflict protection.

## 0.8.2

- Reviewed generated SVG asset plans with per-file SHAs, source differences, size limits, and path validation.
- Server regenerates banner SVGs before accepting writes; arbitrary SVG uploads and hidden/traversal paths are rejected.
- Exact Studio-owned banner reference rewrites, light/dark pairs, preflight conflicts and precise partial-success reporting.

## 0.8.1

- Re-fetch remote SHAs in browser and server before writes; stale changes stop for explicit review.
- Conservative three-way section merging with local/remote/combine/manual conflict decisions and a fresh final diff.
- Explicit branch creation, PR preparation links, previous-version links, local source recovery checkpoints and bounded token-free history.

## 0.8.0

- Optional GitHub App connection through a same-origin Node session boundary; credentials never enter browser draft storage or exports.
- Explicit repository/branch/README selection, remote baseline, source diff, editable commit message and confirmed create/update publishing.
- Permission-aware picker, commit links, protected/network failure messages and preserved local download fallback.
- Mocked auth/security and three-engine publishing coverage; deployment and authentication limits documented.

## 0.7.3

- Added a worker-based Safe Refactor Assistant with mandatory Before/After/Diff review, explicit Apply/Cancel and stale-review rejection.
- Added conservative heading, alt, picture, badge-row, separator, empty-section, HTML and URL transformations with deterministic overlap rejection.
- Preserved untouched source and query strings, added offset mappings, and integrated one-step undo with explicit Custom Markdown detachment.
- Added malformed-source, large-plan, mobile, offline and cross-browser workflow tests and complete analyzer/compatibility/Rust/refactor guides.

## 0.7.2

- Added a dedicated GitHub Compatibility Lab with support/safety filters, explanations, alternatives and source navigation.
- Added picture, details, table, styling, event and URL diagnostics that distinguish mobile layout from preview security.
- Added documented GitHub-style fixtures, encoded-URL tests and mobile keyboard coverage without claiming exact GitHub parity.

## 0.7.1

- Added a lazy local WASM statistics core with JavaScript fallback and a portable, parity-tested Rust structural API.
- Benchmarked JavaScript before migration and reduced transfer overhead based on measurements.
- Added native Rust tests, rebuilt-WASM CI, 1 MB parity checks and bounded Health rendering.

## 0.7.0

- Added source-aware README analysis, section inventories and neutral statistics.
- Added explainable accessibility, structure, security, layout and clutter guidance with category views and keyboard source jumps.
- Shared worker tokenization, bounded findings and added Unicode, CRLF, code-exclusion and large-document tests.

## 0.6.3

- Added a consolidated Refresh Center with source inventory, fetch ages, selected/all refresh, per-source change review and partial-failure reporting.
- Preserve manual profile/project fields and edited repository sections; retain detached source records for explicit append-only recreation.
- Apply accepted changes in one undo/autosave step, reject stale reviews, include ownership in backups, and invalidate network Health cache after refresh.
- Hardened optional metadata handling and lazy full-source diff rendering; GitHub requests omit credentials/referrers.

## 0.6.2

- Added explicit, grouped repository/link/image/badge/widget scans with bounded concurrency, cancellation and temporary cache.
- Distinguish redirects, missing resources, rate limits, timeouts and ambiguous browser-policy failures; inspect public repository changes and exposed image headers.
- Resolve imported relative paths for validation without rewriting source. Export remains available regardless of scan results.

## 0.6.1

- Added explainable Profile Intelligence, eligible project candidates and curated technology grouping.
- Added per-draft dismissals keyed to relevant context and reviewed public contact links. No scores, proficiency claims, prose generation or automatic application.

## 0.6.0

- Added public repository context, reusable authoring picker, cached and explicit lookups, filters and bulk review.
- Generate repository lists, projects, badge groups, confirmed technology suggestions and reusable custom snippets with source ownership.
- Preserve manual Markdown, reuse existing project/badge serializers, and label repository homepages as unverified data.

## 0.5.3

- Added structured component ownership, visual re-editing for template/widget/badge forms, independent duplication and reusable configured presets.
- Raw edits detach safely with undo; mismatched or stale component source requires explicit current/generated review before replacement.
- Extended snippet packs with backward-compatible preset fallbacks and advisory component Health checks that ignore code examples.
- Polished favorite ranking, saved-entry management, bounded 200-item library rendering, hidden-control accessibility and badge-editor focus; split syntax highlighting into a reusable static bundle chunk.

## 0.5.2

- Added versioned portable snippet packs with metadata, saved snippet/badge collection selection and exact draft-section copies.
- Added validated import review, per-item source/preview, Keep both/Replace/Skip collision policies and atomic local persistence.
- Included four editable example kits and all-reusable-snippets backup with no hosted sharing dependency.

## 0.5.1

- Added the Dynamic Widget Hub with seven attributed upstream projects, setup/hosting guidance, shared favorites and generic light/dark embeds.
- Added a local Typing SVG URL helper, explicit remote preview with broken/offline states, optional README credit and clipboard fallback.
- Added advisory widget Health checks for duplicates, clutter, missing alt text and inconsistent widths without analyzing fenced examples.

## 0.5.0

- Added a searchable Component Library with 34 editable starters, category filters, source inspection and sanitized previews.
- Added explicit cursor/before/after/append insertion, local favorites/recents and exact-source custom snippet saving.
- Included versioned reusable components in workspace backup/recovery with safe interpolation and collision handling.

## 0.4.3

- Added reusable theme libraries, banner presets and visual bundles with rename/duplicate/delete, validated JSON import/export, theme packs, and visual packs.
- Added a local light/dark gallery and reviewed preset application that preserves explicit overrides by default. Visual presets contain configuration only, never README prose or banner text.
- Included visual libraries in workspace backup/restore, collision handling, and damaged-storage recovery; failed saves leave saved data intact.
- Cached local banner samples, avoided generating SVG when only picture markup is needed, and hardened ownership records and unsafe/incomplete preset validation.
- App light/dark changes now switch the README preview and picture variants too, while preserving the separate preview toggle and source Markdown.

## 0.4.2

- Added per-section heading/divider styles, editable accent glyphs, theme inheritance/reset, and centered compact image/badge content.
- Added readable callouts, collapsible details, safe fenced code samples, and escaped two-column helpers using ordinary GitHub Markdown/HTML.
- Added advisory styling Health checks for centering/divider/prompt/glyph overuse, nested details, and large table layouts. Custom Markdown remains excluded from styling.

## 0.4.1

- Added local SVG Banner Builder with eight restrained styles, deterministic seeds, dimension presets, editable content, and theme palette defaults with independent overrides.
- Generate light/dark asset pairs, preview desktop/mobile widths, download SVGs, copy source or README picture markup, and insert markup without uploading anything.
- Bounded dimensions/text, escaped XML, required alt text, safe filenames, clipboard fallback, and draft-specific banner settings keep output portable and recoverable.

## 0.4.0

- Added draft-specific visual themes, nine built-in palettes, custom palette/default editing, light/dark samples, and advisory contrast guidance.
- Theme-owned settings follow subsequent theme changes while explicit overrides remain intact. Reset is explicit and confirmed; Custom Markdown is never decorated.
- Integrated badge defaults and builder/project heading/divider presentation with undo, draft persistence, and ordinary Markdown output.

## 0.3.3

- Added advisory project Health checks for missing context, links, alt text, roles, repeated names/repositories/technology aliases, large stacks, archived status conflicts, and stale source activity.
- Added project search, collapse/expand all, bulk reviewed GitHub refresh, copy all, and versioned portable project packs with validation and deterministic collision handling.
- Added explicit bounded link checks that distinguish unavailable URLs from browser/network restrictions, plus source-change review and last-refreshed dates.
- Deferred collapsed forms and screenshots, tested 10/25/50-project showcases, and hardened field escaping, ownership preservation, table output, keyboard focus, and offline editing.

## 0.3.2

- Added compact, detailed, featured, card, two-column, case-study, and featured-first project layouts through pure serializers.
- Added layout presets, screenshot placement and light/dark pictures, responsive preview widths, and single-project copy with selectable fallback.
- Project table layouts include mobile guidance in README Health. Layout changes preserve the full editable model.

## 0.3.1

- Review public GitHub repository metadata before creating or refreshing project entries.
- Filter and select cached GitHub Autofill repositories; bounded multi-import preserves partial successes and explains unavailable/rate-limited repositories.
- Confirm duplicate repositories, explicitly select language/topic and archived-status suggestions, and preserve manually edited fields during ownership-aware refresh. No roles, highlights, or statistics are invented.

## 0.3.0

- Project Studio adds normalized editable projects, roles/types, engineering highlights, catalog/custom technologies, status, links, and accessible screenshots.
- Attach independent badge collection copies or compose individual badges with the existing Badge Studio.
- Keyboard reorder/duplicate/delete, collapsed editors, live section preview, explicit save/undo, and exact legacy source preservation until migration is saved.

## 0.2.3

- Advisory badge alt-text, approximate contrast, duplicate technology/URL/status, long-row and per-section clutter guidance; code examples and comments remain excluded.
- Resilient collection backup/restore and partial corruption recovery, bounded large-collection previews, and explicit unsaved-edit handling.
- In-place clipboard fallback, offline markup generation, strict color/style/URL validation, and local builder validation errors.
- Desktop side-by-side preview, mobile wrapping, predictable WebKit dialog focus, and Chromium/Firefox/WebKit workflow coverage.
- Completed badge, privacy, accessibility, and architecture documentation.

## 0.2.2

- Guided dynamic helpers for GitHub workflow/stars/forks/issues/license/releases, npm version/downloads, crates.io version/downloads, PyPI, Docker, Netlify, and public Shields JSON endpoints.
- Local format validation, explicitly chosen repository suggestions, editable click-through links, and provider-specific cache settings.
- No API lookups while typing, no proxy, and clear remote preview/privacy limitations.

## 0.2.1

- Reusable local badge collections with editable starters, alias search, keyboard reorder/edit/duplicate/remove, and portable versioned JSON.
- Plain, centered, picture and category output; desktop/narrow/mobile previews with bounded remote images.
- Save badges or stack categories as collections and insert independent copies into drafts or stack blocks.

## 0.2.0

- Dedicated Badge Studio with editable presets, searchable technology logos, smart defaults, and live Markdown/HTML/URL previews.
- Theme-aware light/dark badge pairs and safe centralized Shields serialization.
- Insert at the cursor, into a badge row, or at the end of a builder section; undo remains available.

## 0.1.3

Foundation Hardening.

- Standardize dialog and action focus, announce selected states, improve contrast, reduced motion, keyboard reordering, and mobile touch targets.
- Add all-drafts backup/validated restore, deterministic collision handling, original-data recovery downloads, and persistent storage failure notices.
- Separate preview, Worker Health, and autosave scheduling; remove quadratic token traversal and cap history by count and estimated bytes.
- Centralize URL validation, restrict untrusted preview classes, expand malicious-markup tests, and preserve exact Markdown exports.
- Keep editor/export available after preview failures; add runtime recovery actions, clipboard fallback, safe filenames, offline messages, and rate-limit retry times.
- Harden narrow layouts and long draft names, including WebKit overflow; test Chromium, Firefox, WebKit, 100/250 KB documents, and static subpath hosting.
- Review the installed dependency tree without unnecessary upgrades; document browser support, recovery, performance, fixtures, and contributor checks.

## 0.1.2

Import Intelligence.

- Review GitHub, local Markdown, and Studio backups before choosing new draft, confirmed replacement, append, or merge.
- Preserve exact source while splitting H1/H2 sections, with preamble handling and advisory section kinds.
- Resolve relative GitHub images, picture sources, repository links, and local anchors in preview only; show unresolved local images clearly.
- Explicit section merge choices, likely matches, duplicate warnings, resulting Markdown review, and one-step undo/redo.
- Re-import GitHub-backed drafts with SHA change detection, source provenance in backups, bounded 2 MB reads, cancellation, and actionable errors.
- Add realistic fixtures and unit/browser coverage for source preservation, URL safety, merge decisions, ownership, keyboard use, limits, and performance.

## 0.1.1 — GitHub Autofill

- GitHub profile autofill from a username or profile URL, with a review step and optional fields.
- Safe name/username placeholder replacement, public bio/contact details, dated public stats, and optional project, language, and avatar suggestions.
- Conservative refresh of unedited autofill content, undo/redo, persistence, pagination, partial-results handling, and mocked profile API tests.
- Refresh untouched hero introductions and sample contact URLs; preserve manual edits and remove previously generated contact details when no longer public.
- Cancel obsolete GitHub requests when input changes or the dialog closes. Reject applying a preview if the draft changed after review.
- Handle malformed API responses, preserve completed repository pages on timeout, and ignore malformed legacy identity metadata.
- Add keyboard focus, cancellation, security, storage/backup compatibility, refresh, and stale-preview regression coverage. Display the application version from package metadata.
- Give browser tests a dedicated configurable port and reject reuse of unrelated local servers.

## 0.1.0 — 2026-09-27

Initial local-first release.

- Markdown editor with undo/redo, tab support, and sanitized GitHub-style live preview.
- Visual sections, conservative Markdown ownership, Custom Markdown, and five editable templates.
- Badge generation and badge rows, including theme-aware variants.
- Searchable technology stack, project showcases, and social/contact builders.
- Attributed external widget library and light/dark image helper.
- Advisory README Health and clutter suggestions.
- Named local drafts, autosave, JSON backups, public GitHub/file import, and Markdown copy/download.
- Responsive preview sizes, desktop pane collapse, mobile navigation, and keyboard controls.
- Unit/browser tests, CI, architecture documentation, and static deployment configuration.
