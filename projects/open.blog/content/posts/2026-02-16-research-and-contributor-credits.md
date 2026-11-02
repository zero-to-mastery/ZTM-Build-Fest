---
title: Research posts and contributor credits
date: 2026-02-16
tags:
  - research
  - guide
  - collaboration
description: A working example of research metadata, ordered authorship, contributor roles, references, and the Admin Studio workflow.
profile: research
license: https://creativecommons.org/licenses/by/4.0/
---

## Abstract

This working example shows how a portable Markdown article can publish research-oriented
metadata and credit more than one person without putting identity data in front matter. The
post selects the `research` profile, while an adjacent JSON sidecar supplies ordered authorship
and controlled contributor roles.

## Follow the source files

Three files make the demonstration work:

1. `openblog.json` registers the reusable `example-author` and `example-editor` identities.
2. This Markdown file contains the article, license, Abstract, and References sections.
3. `2026-02-16-research-and-contributor-credits.credits.json` connects those identities to
   this work with Crossref and CRediT roles.

The identities are deliberately synthetic and their ORCID fields are empty. Replace them with
real people and add only identifiers those people actually control. Manually entered ORCID iDs
remain visibly labeled as unauthenticated.

## What to inspect

Open this post in Admin Studio to see the same data from an author's point of view:

- **Settings → Credit contributors and roles** preserves credit order and exposes controlled
  roles.
- **Evidence** reports the research structure and bounded reference links below.
- **Site preview** renders the production byline, work details, and Contributions panel.
- **Social** uses the same publishing-engine metadata as the generated page.

After `openblog build`, inspect this page, `rss.xml`, `feed.json`, and the page's JSON-LD.
Only the Crossref author appears in author-only metadata; both people and all their roles remain
visible in the Contributions panel.

## References

1. [CRediT role taxonomy](https://credit.niso.org/)
2. [Crossref contributor guidance](https://www.crossref.org/documentation/schema-library/markup-guide-metadata-segments/contributors/)
