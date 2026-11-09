# Stack-to-README

Version 1.9.11 turns an opt-in manifest scan into editable documentation suggestions. Detected technologies are repository evidence, never developer proficiency.

## Review workflow

1. Open the draft you want to improve. Repository Audit's **Open in Studio** can first open an existing repository README without replacing your current draft.
2. Open **README audit**, load an account, select repositories, and allow read-only manifest analysis for this session.
3. Choose **Analyze selected manifests**, expand a repository result, then **Review README suggestions**.
4. Confirm the repository and target draft names. Inspect each claim's Provenance and caveats; the review names its repository, Project boundary, Manifest path and section, branch, observation time, and file revision when available. Select individual suggestions and edit their Markdown. Nothing is selected automatically.
5. Confirm each selected suggestion for this repository. **Review exact diff** remains unavailable until every selected item is confirmed.
6. Compare the current and resulting source, then explicitly approve the whole change and choose **Append reviewed suggestions**.

Editing a suggestion clears its Confirmation. Edits or selection changes invalidate whole-diff approval. A changed draft blocks application: reopen the review against the new draft. Escape or the dialog close control discards unapplied choices. Keyboard controls and narrow screens are supported.

Selected suggestions append as individual Custom Markdown blocks. Existing source, builder settings and metadata remain intact; Undo restores the prior draft. No existing heading is silently replaced or deduplicated. Review repeated headings and conflicting package-manager guidance before applying. Export remains ordinary Markdown.

## Suggestions and limits

| Suggestion                  | Evidence and boundaries                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Badges and stack sections   | Curated Stack DNA technology mappings and existing language/engine evidence. Unknown dependencies are omitted. Each badge is individually selectable. Each evidence line names its Confidence basis.                     |
| Node manager/install        | Recognized `packageManager` declaration, otherwise explicitly suggested npm fallback. Lockfiles are not inspected.                                                                                                       |
| Node test/build             | Offered only for nonempty string `scripts.test`/`scripts.build` declarations. Only names are retained; script bodies and hooks are not evaluated or shown.                                                               |
| Rust setup/build/test       | Conventional Cargo commands from root `Cargo.toml`; feature flags, target selection and prerequisites need review.                                                                                                       |
| Python installation/testing | pip conventions for `pyproject.toml` or `requirements.txt`; pytest command only when directly declared. A pyproject may not describe an installable package. Confirm virtual environment and manager-specific workflows. |
| Go setup/build/test         | Conventional module download and recursive build/test commands from root `go.mod`. Confirm required flags and generated code steps.                                                                                      |
| Package/crate links         | Declared npm, Cargo or Python package identity. Public registry publication, ownership and availability are not verified. npm private packages and Cargo disabled/registry-specific publishing suppress public links.    |

Suggested commands are documentation text, not executable actions. Studio never installs dependencies, invokes package scripts, runs repository code or executes build tools. A reviewed command can still be unsafe to run: inspect the actual repository and lifecycle hooks first. Conventional commands follow upstream [npm scripts](https://docs.npmjs.com/cli/v11/commands/npm-run/), [Cargo fetch](https://doc.rust-lang.org/cargo/commands/cargo-fetch.html), [pip local installs](https://pip.pypa.io/en/latest/topics/local-project-installs/) and [Go modules](https://go.dev/ref/mod) documentation.

Suggestions make no additional network requests. Source review does not load badge images. Once inserted and rendered in preview, badges contact Shields.io directly. Package links contact their destination when opened. No draft text is sent to a registry for verification.

The existing root-only scan, request/concurrency limits, cancellation and session cache apply. Partial results yield suggestions only from available evidence. The review identifies observation time and branch; refresh the scan when evidence may be outdated. Dynamic configurations, workspace member manifests, lockfiles and arbitrary script names are outside this release.

See [Stack Intelligence](stack-intelligence.md) and [Stack DNA](stack-dna.md) for collection and mapping boundaries.
