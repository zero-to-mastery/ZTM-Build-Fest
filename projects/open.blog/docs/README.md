# open.blog documentation

If you are new, read these in order; each one stands alone otherwise.

1. [Writing content](content.md): where files go, what a post looks like, series, pages,
   drafts, scheduling, images, code blocks, callouts, recipes, and every front matter field.
2. [Configuration](configuration.md): every setting in `openblog.json`, with defaults.
3. [Deploying](deploy.md): GitHub Pages, other static hosts, running your own server,
   and keeping old URLs working.
4. [Publishing from home](publishing.md): the Publish button, git as your backup, view
   counts on a static host, and a counter you can host for free.
5. [Cross-posting](cross-posting.md): safely syndicate articles to Hashnode, DEV, Medium,
   Ghost, and WordPress without leaking credentials or creating duplicate originals.
6. [Themes and the design system](themes.md): how a theme is built from design tokens,
   light and dark, per-series themes, and making your own.
7. [Adding web components to a theme](theme-components.md): scripts, heading effects,
   and the demo theme to copy from.
8. [The admin editor](admin.md): the writing workspace, production-faithful theme and
   social previews, search, answer-readiness and accessibility guidance, optional AI review,
   safe suggestion application, knowledge-check proposals, opt-in autocomplete, provider
   configuration, scheduling, and safe operation.
9. [Sharing, views, analytics, and embeds](features.md): share links, the view counter,
   Supabase-backed Netlify comments and analytics, syntax highlighting, related posts, a CDN, and
   slots for comments or newsletters.
10. [SEO and answer discovery](seo.md): publishing checks, AI crawler policy, text feeds,
   and machine-access analytics.
11. [Accessibility checks and manual review](accessibility.md): source findings, outcome
   meanings, known limits, and a rendered-site review workflow.
12. [Research posts and Evidence Studio](research-profile.md): DOI and license fields,
   visible references, contributor-credit demonstration, scholarly metadata, deterministic
   evidence checks, and their limits.
13. [Research checks](research-checks.md): what every finding in the research report means, how to
   fix it, and what acknowledging one does and does not mean.
14. [Video productions and release kits](video-production.md): YouTube embeds, transcripts,
   chapter validation, structured data, and reusable release copy.
15. [Field journals and private-by-default tracks](field-journal.md): local GPX analysis,
   trail facts, route drawings, and enforceable location-privacy modes.
16. [Showing your posts on another site](integrations.md): feeds and the latest-posts JSON.
17. [Migrating from Hashnode](hashnode-migration.md): with or without a paid plan.
18. [Migrating inherited authorship](contributor-migration.md): dry-run-first contributor credits.
19. [Interpretation comparisons](interpretation-comparisons.md): attributing readings, recording uncertainty,
   audience explanations, and your responsibility for AI-drafted text.
20. [Jobs](jobs.md): finished trade work as posts, with a documented `job` front matter.
21. [Services](services.md): each service described once, with a price band, a timeline and FAQs.

Architecture decisions and their supporting primary-source research live under
[`docs/adr`](adr/) and [`docs/research`](research/).
The [shared-publication language decision](adr/0005-shared-publication-language.md) separates
private collaboration, source material, and draft approval from canonical posts and public credit.
The [collaborator identity binding decision](adr/0006-collaborator-identity-binding.md) defines
how an Admin user explicitly becomes a publication participant and what each collaboration role
may do. The [shared publication record decision](adr/0007-private-shared-publication-records.md)
keeps each shared reflection's sources, contract, and policy in one private file outside your
content.

How posts keep their meaning outside open.blog is recorded under
[`docs/portability`](portability/): the [capability matrix](portability/capability-matrix.md),
the [portable HTML pipeline](portability/portable-html-pipeline.md) with its static fallbacks and
raw HTML policy, and the [planned-capability contracts](portability/planned-capability-contracts.md).
The [portable lesson example](../examples/portable-publishing/README.md) demonstrates one canonical
post across exports, feeds, Admin previews, and all destination plans without remote writes.

Current design frontiers include
[contributor identity and ORCID provenance](research/contributor-identity-and-orcid.md),
which defines the incremental path from one site author to ordered, work-specific credit,
[Assistant provider APIs](research/assistant-provider-apis.md), which records the native-provider
contracts and why GitHub Copilot is not exposed as a generic API provider, and the
[research source library format](specs/research-source-library.md), which keeps works,
editions, translations, witnesses, and references distinct under stable identifiers, and the
[research notebook format](specs/research-notebook.md), which keeps quoted passages and private
research notes apart from your own prose, with private search and backlinks
([ADR 0036](adr/0036-private-notebook-search-and-backlinks.md)), and archive, export, import and
publication-leak guards ([ADR 0037](adr/0037-private-notebook-lifecycle-export-and-leak-guards.md)),
the [citation format](specs/citations.md), which points citations at source identifiers with
compound locators and states what is public and how CSL data is kept or reported lost
([ADR 0042](adr/0042-citation-keys-are-source-identifiers.md) to
[ADR 0046](adr/0046-csl-interoperability-policy.md)), with an Admin citation picker that keeps
citations intact in both writing modes ([ADR 0047](adr/0047-citation-picker-in-the-visual-editor.md)),
publication as notes or a bibliography through the one publication projection
([ADR 0048](adr/0048-citations-publish-through-the-one-publication-projection.md),
[ADR 0049](adr/0049-built-in-citation-styles-locales-and-accessible-notes.md)), and offline
citation checks with CSL JSON and BibTeX exports of a post's cited references
([ADR 0050](adr/0050-offline-citation-checks-and-portable-bibliography-exports.md)), and the
[Knowledge Atlas format](specs/knowledge-atlas.md), which keeps people, works, concepts, movements and
events typed and records every relationship as an attributed, evidence-backed assertion that is
never presented as consensus, stored privately beside the notebook
([ADR 0055](adr/0055-private-knowledge-atlas-storage.md)) with one lock order and guards that
keep sources and passages it uses from being removed
([ADR 0056](adr/0056-one-lock-order-and-cross-store-research-guards.md)), and dates its entries
and relationships with attributed, cited datings at their stated precision that keep competing
datings side by side
([ADR 0093](adr/0093-uncertain-dates-are-attributed-datings-at-their-stated-precision.md)), whose
only temporal relationship is an asserted relative dating
([ADR 0094](adr/0094-temporal-relationships-are-relative-datings-never-inferred.md)) and which
replace version 1's `bounds` privately
([ADR 0095](adr/0095-atlas-version-2-supersedes-bounds-and-keeps-datings-private.md)), indexed
in one deterministic display order
([ADR 0096](adr/0096-the-chronology-index-orders-every-dating-for-display-only.md)) with
structural prompts that never judge which dating is right
([ADR 0097](adr/0097-chronology-prompts-are-structural-and-never-verdicts.md)), and the
[claims and evidence links format](specs/claims-evidence.md), which records the author's own
reading of which sources support, contradict or contextualize a claim in a draft, with no score
or verdict ([ADR 0068](adr/0068-claims-and-evidence-links-record-the-authors-reading.md)), never
publishes support while contradiction is withheld
([ADR 0069](adr/0069-contradicting-evidence-is-never-hidden-or-published-alone.md)), and checks
claim anchors against the draft without repairing them
([ADR 0070](adr/0070-claim-anchors-are-verified-utf8-byte-spans.md)), stored privately and
checked against each post's saved draft
([ADR 0071](adr/0071-private-claims-storage-checked-against-the-saved-draft.md)) with a lock
order and guards that keep the sources and passages it uses
([ADR 0072](adr/0072-claims-take-their-lock-after-the-atlas-and-guard-their-sources.md)), and
authored from a selection in Evidence Studio with supporting and contradicting evidence side by
side ([ADR 0073](adr/0073-claims-are-authored-from-a-selection-in-evidence-studio.md)), with
evidence gaps and provenance prompts that `openblog check`, builds and Evidence Studio report
alike and that never judge whether a claim is true
([ADR 0074](adr/0074-evidence-gaps-are-prompts-in-the-shared-finding-contract.md)), gathered with
every other research check into one readiness report that Admin, `openblog check`, builds and the
preview show with the same codes in the same order
([ADR 0150](adr/0150-one-research-readiness-report-across-admin-check-build-and-preview.md)), and, when a
site opts in, publishes approved claims with their evidence side by side as a section of the
post, with revision notes the post itself carries
([ADR 0075](adr/0075-publish-approved-claim-evidence-in-the-post-with-public-revision-notes.md)),
and the [passage alignments format](specs/passage-alignments.md), which records where places in
editions, translations, witnesses, and interpretations correspond, many to many and including
passages a version lacks, keeps the original wording apart from the author's normalization, and
never calls aligned places equivalent
([ADR 0088](adr/0088-passage-alignments-record-correspondence-never-equivalence.md)), stored
privately with a lock after the claims file and guards on the sources, interpretations, and
passages it uses
([ADR 0089](adr/0089-alignments-take-their-lock-after-claims-and-guard-what-they-use.md)),
and read in Admin's comparison workspace, which shows each version's places side by side or in
one column with every place identified and its wording exact
([ADR 0090](adr/0090-the-comparison-workspace-reads-one-snapshot-and-identifies-every-place.md)),
and copies only the places the author selects, with their rights statements
([ADR 0091](adr/0091-copying-from-a-comparison-takes-only-selected-places-with-their-rights.md)),
and the [curated context format](specs/curated-context.md), the versioned public data file and the
static section of each post that give readers the research context the author selected, built from
one public value that no private note can reach
([ADR 0197](adr/0197-the-curated-context-file-is-a-bounded-versioned-projection-of-the-one-public-curated-value.md)).

## Command reference

```
openblog init [dir] [--title "..."] [--github-pages]
                                        Create a new blog (optionally with a Pages workflow)
openblog new "Title" [--series s] [--tags a,b] [--draft] [--recipe]
openblog build [--drafts] [--out dir]   Write the site to dist/
openblog serve [--admin] [--drafts] [--host 127.0.0.1] [--port 8080]
openblog check [--json]                 Validate content, themes, and the private source library, notebook, Knowledge Atlas and claims, write nothing;
                                        --json prints the research readiness report as JSON
openblog export <slug> [--format markdown|csl-json|bibtex] [--out path] [--write]
                                        Preview or write portable Markdown, or the post's
                                        cited references as CSL JSON or BibTeX
openblog syndicate <slug> [--target a,b] [--write] [--publish]
                                        Preview or explicitly send portable copies
openblog themes                         List themes and what they extend
openblog publish [summary]              Commit changed content with git and push
openblog publish setup                  Create the repository and Pages workflow
openblog analytics backup               Save view counts to the analytics branch
openblog analytics pull <url> --secret s
                                        Merge counts from a hosted counter
openblog analytics worker [dir]         Write a Cloudflare Worker counter
openblog analytics service [dir]        Write a Node + MongoDB counter (Render)
openblog user add|passwd|remove|list <name> [--password-stdin]
openblog contributors migrate --id <stable-id> [--write]
                                        Dry-run or write explicit legacy-author credits
openblog import hashnode <host> [--source public|graphql] [--token t]
                                        [--limit n] [--no-images] [--delay ms] [--overwrite]
openblog help
```

Every command accepts `--root <dir>` to work on a blog in another folder. `--drafts`
includes drafts and scheduled posts, for previews.

`openblog build-wasm` exists for people working on the engine itself: it recompiles the
search module from the open.blog source tree. A blog made with `openblog init` already
contains the compiled module under `web/wasm/`.

## Getting help

Open an issue at <https://github.com/journey-to-code-org/open.blog/issues>. Include the
command you ran and its output; `openblog check` reports most content problems with the
file and reason.
