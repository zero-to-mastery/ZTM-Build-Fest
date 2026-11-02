# ADR 0001: Accessibility Studio separates detected findings from human review

- Status: Accepted
- Date: 2026-10-23
- Decision issue: [#4](https://github.com/journey-to-code-org/open.blog/issues/4)
- Research: [Accessibility Studio research](../research/accessibility-studio.md)

## Context

open.blog can inspect canonical front matter, Markdown syntax, the site model, and its own
rendered output. It cannot infer whether every image alternative conveys the author's
intent, whether link wording is meaningful in context, or whether a themed page works
with every keyboard and assistive-technology combination. Treating all of those concerns
as equivalent automated checks would give authors false confidence.

The existing SEO and answer-readiness view is a browser-side heuristic with a percentage
score. Accessibility guidance needs a different contract because an empty result cannot
mean that a page conforms to WCAG.

## Decision

The first Accessibility Studio release will use a shared Rust audit over canonical source
and site configuration. The same findings will be available to command-line validation
and the admin preview response.

Each finding has a stable product-owned code, one of three outcomes (`detected`,
`potential`, or `needs-review`), a scope, a source location when available, a concise
message, repair guidance, and informative standards references. Codes will not include a
WCAG version, so references can evolve without breaking API consumers.

The admin will add a dedicated **Accessibility** view. It will show outcome counts and
grouped findings, not a score or universal pass. The persistent disclosure will explain
that the studio checks selected source concerns, does not test every accessibility
requirement, and does not certify WCAG conformance.

The initial source audit will cover:

- empty accessible names on text links;
- missing site-language configuration;
- empty or placeholder-like image alternatives as review or potential findings;
- skipped heading levels as potential findings;
- generic link phrases as potential findings;
- the presence of tables, media, embeds, or raw HTML as contextual review tasks.

The first release will not persist manual-review acknowledgements. It will not mutate
front matter, auto-generate alternative text, or claim that dismissed findings are
resolved. Raw HTML receives one bounded review task instead of a partial HTML conformance
checker.

Contrast, focus visibility, keyboard behavior and order, reflow, reduced motion, target
size, responsive states, and third-party embed behavior remain rendered-browser review
work. A later release may assist with those checks, but it must preserve the same
non-certification boundary.

## Integration seam

The core owns the audit types and source analysis. The loaded site model carries
structured accessibility findings separately from its existing publishing warnings.
`openblog check` reports them with their outcome, while the admin preview returns only
site-wide findings and findings for the document being edited. This prevents unrelated
posts from appearing in the current editor.

The browser only renders the returned contract; it does not reimplement the rules. This
keeps Markdown parsing, CLI output, and editor guidance consistent.

## Consequences

- Authors get actionable guidance without a misleading compliance badge.
- The CLI and admin share one analysis path.
- Findings can gain standards mappings or rendered-browser evidence without changing
  their stable codes.
- Theme and interaction accessibility remain visibly unfinished until they are reviewed.
- A future decision is required before review state becomes durable publishing metadata.
