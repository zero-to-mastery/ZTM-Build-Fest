# Project Showcase Studio

## Manual projects

Open Project Studio from the header to edit the first showcase or create one. The existing project builder also opens its selected block in Project Studio. This working copy is separate from the draft until Save showcase; closing with unsaved changes asks before discarding. Undo restores the saved change in one step.

Add a project, name the problem it solves, and explain what you personally contributed. Roles, project types and status have suggestions but accept custom text. Engineering highlights have repeatable titles and descriptions: describe architecture, testing, accessibility, performance or meaningful technical decisions. Nothing is auto-written.

Search the shared technology catalog or enter a custom technology. Choose inline code chips (default), badges or plain text. Repository, Live Demo, Case Study and custom links render only when populated and safe. Optional status can be text, badge or hidden; manually entered status is not a verified GitHub fact.

Images use a URL, meaningful alt text, optional click target, width and alignment. There is no upload service. Attach a saved badge collection as an independent copy or compose a badge with the existing Badge Studio. Remote images contact their providers when previewed; source stays local.

Use native details controls to collapse editors, and labeled buttons to move, duplicate or delete entries. The preview renders the same serialized section that will be saved. Existing legacy project fields migrate when opened, including links, highlights, technologies and original status Markdown, but their source is unchanged until Save. If conversion fails, the original Markdown remains editable/exportable. Imported/custom Markdown is never automatically converted.

## GitHub import and refresh

Choose Import GitHub projects, enter owner/repository, and look up public metadata. Or run GitHub Autofill first to cache its public repository list locally, then filter by name/description, language, archived state or fork state and sort by name, stars or updated date. Select up to fifty repositories per batch. Up to three lookups run concurrently with twelve-second timeouts; failed repositories do not discard successful results. No README HTML or dependency manifests are fetched, and no authentication is required.

Review name, description, homepage, primary language, topics, archived state, license and the returned stars/forks snapshot. Missing statistics remain Unknown. Choose fields to apply; technology and archived-status suggestions are opt-in. No role or engineering highlight is inferred. Existing repository URLs produce a duplicate warning and require explicit confirmation. Applying review edits only the working showcase; Save showcase updates the draft.

Imported entries record repository identity, last fetch time, the public snapshot and generated field values. Refresh from GitHub fetches that source again and shows the same review. A field is refreshed only if it is still equal to its previously imported value; manually changed fields and fields that were never imported are preserved. Roles and highlights never come from GitHub. Reopening or reloading retains this ownership record. Rate limits, missing repositories, offline/network failures and timeouts are explained; no automatic retries or writes to GitHub occur.

Reference: [GitHub repository metadata API](https://docs.github.com/en/rest/repos/repos#get-a-repository).

## Layouts and screenshots

Choose one layout for the showcase: compact, detailed, featured, card, two-column, case-study, or featured-first (one featured project, remaining entries compact). Portfolio, Technical, Minimal, Visual, and Case Study presets select these existing layouts. Changing layout never removes stored fields. Compact intentionally shows only the name, description, stack, and links. Case-study adds only populated Problem, Architecture, Challenges, Testing, and Outcome sections; role, stack, and links remain in the main entry.

Screenshots support top, below-title, hidden, or side-by-side placement. Side-by-side uses a GitHub-safe table in non-compact layouts. Light and optional dark URLs generate a picture element, with optional image link, width, and alignment. No images are uploaded. Cards and paired columns use plain HTML without custom CSS; an odd final project spans both cells. Narrow screens can scroll tables. Prefer compact or detailed for linear mobile reading.

Use desktop, narrow (600px), or mobile (320px) preview widths to inspect wrapping. Copy project Markdown exports one entry in the selected layout. If clipboard access fails, a selectable field appears without closing the editor. Generated Markdown remains editable in the main source editor after saving.

## Guidance and maintenance

Project guidance in the studio and Projects in README Health provide advisory suggestions, never a score or automatic rewrite. They cover missing descriptions/links/roles/screenshot alt text, empty highlights, duplicate names and repositories, repeated technology aliases, descriptions over 600 characters, and stacks over 12 entries. A simple feature-word heuristic can suggest explaining engineering decisions; it cannot assess the quality of your work. Describe your actual contribution and tradeoffs in your own words.

Imported entries show the last refresh date. Refresh review lists changed source fields and fields owned by your manual edits. Bulk refresh uses the same review and preservation rules, including duplicated entries from one repository. GitHub's archived flag can conflict with an Active status. A push date over two years old may generate a neutral maintenance note; inactivity does not mean abandonment.

Search by project name, technology, status, or source repository. Collapse all and Expand all affect editor forms only. Showcase layout changes apply to every entry; Copy all project Markdown copies the whole section. Delete always asks for confirmation; pack imports append rather than replace. You must save the showcase to update the draft, and the change remains undoable.

## Portable project packs

Export project pack downloads `projects.showcase.json`, with `{ "version": 1, "type": "project-showcase", "projects": [...] }`. Only project fields and public GitHub ownership metadata are included, not unrelated draft settings or metadata. Import a JSON file or paste JSON, review its version/count, then append. Malformed/future schemas are rejected without changing the working showcase. Packs accept up to 100 projects, 200 items per nested list, and 5 MB of input. Duplicate IDs get fresh IDs; colliding names receive `(2)`, `(3)`, and so on. Duplicate repository references remain visible as advisory guidance.

Use a pack across drafts, or use the full workspace backup to preserve the complete draft and its layout selection. Packs carry project data; the receiving showcase chooses presentation. Exporting a pack does not save pending editor changes to the draft.

## Link checks, privacy, and performance

Check links now is explicit and optional. It sends browser HEAD requests to at most 300 distinct absolute HTTP(S) project/image destinations, with three concurrent requests and an eight-second timeout. Cookies/referrers are omitted and no draft prose is sent. A readable 404/410 response is unavailable; CORS, offline, timeout, or other restricted responses are unverified. These are best-effort observations, not guaranteed link validity, and never block export. Relative and mailto links are not network-checked. Previewing remote screenshots/badges naturally contacts their hosts.

Collapsed project entries defer their forms and screenshot sources. Open the entry to load its screenshot; exported markup always retains the source URL. Ten-, 25-, and 50-project smoke cases cover serialization, guidance, editing, keyboard reordering, and saving without tight timing assertions. Health runs in the existing worker; studio preview is debounced during ordinary field typing. Core project editing, serialization, packs, and export work offline after the app is loaded. GitHub import, link checks, and remote media need a network connection.
