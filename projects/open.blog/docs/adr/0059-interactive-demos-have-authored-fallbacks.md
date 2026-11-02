# ADR 0059: Interactive demos have authored fallbacks

- Status: Accepted
- Date: 2026-10-26

## Context

Lessons are easier to teach when a reader can operate a small model of the mechanism (an in-memory Git,
a simulated network and storage inspector, a live custom element). Portable projections are derived from
the canonical Markdown and must not depend on JavaScript or invent meaning
([ADR 0004](0004-portable-projections-from-canonical-work.md)). A demo placed in a post would reach feeds
and syndication destinations that cannot run it.

## Decision

An interactive demo is a publishing capability (`interactive-demo`) embedded with a `demo <kind>` fence.
The fence body is an **authored fallback**, plain Markdown, and it is the portable representation: native
pages wrap it in the demo element (which hides it once running), and feeds, portable HTML and portable
Markdown carry the caption, the fallback and a link to the live version. The fallback is validated rather
than sanitized (no raw HTML, no images, absolute https links only), so one text is safe in every output.
The portable semantic-fact check fails an export that loses the fallback's text, the kind's label, the
title or the canonical link. Kinds are a closed registry in the engine, so an unknown kind fails the build.

## Consequences

- A demo is only as portable as its fallback is good; the fence therefore asks the author to write the
  moment the demo teaches.
- The fallback cannot be generated from the demo's model. That keeps Rust and JavaScript from each
  re-implementing the model, at the cost of the author keeping prose and demo consistent.
- Adding a demo kind touches the engine registry (`DEMO_KINDS`), the embedded asset list in `site.rs`,
  the element import in `web/openblog.js`, the styles and the docs.
