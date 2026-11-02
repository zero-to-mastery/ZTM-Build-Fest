# ADR 0040: Series name their authors only when they hold a collaborative work

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#184](https://github.com/journey-to-code-org/open.blog/issues/184)
- Parent story: [#151](https://github.com/journey-to-code-org/open.blog/issues/151)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0038](0038-shared-publications-join-the-existing-series.md) lets a shared reflection join an
ordinary series and derives the series' contributors from its posts' work credits
(`Site::series_contributors`), but it left them off the series page: every legacy post carries a
default site-author credit, so showing credits everywhere would change the output of every
existing series. Readers still need to tell, from the series page and from each part's previous
and next links, who wrote a collaborative part and who wrote the ordinary parts around it.

## Decision

- **A collaborative work** is a published post whose approved work credits, the explicit credit
  sidecar the shared-publication gate writes, name two or more authors (`Post::is_collaborative`).
  A legacy post's default site-author credit never counts, nor does a single credited author, nor
  any editor or other secondary role. The test reads only the credits, never collaboration state.
- **A collaborative series** is one with at least one collaborative part
  (`Site::series_is_collaborative`). Drafts and scheduled posts are not parts, so they never make
  a series collaborative and never appear in it. Only a collaborative series changes:
  - its page puts "Contributors: A, B, and C" (from `series_contributors`) between the
    description and the parts, and adds "By ..." to the start of each part's meta line;
  - every part's series navigation adds "By ..." inside the previous and next links, after the
    title, and after each entry of All parts.
  Every other series, including one whose posts have explicit single-author credits, renders byte
  for byte as before. A series stops being collaborative, and returns to that output, as soon as
  its last collaborative part is removed or loses its second author.
- **Every part is credited,** ordinary ones included, so a collaborative work reads as one more
  part, not as a special case. Names come from each post's author credits in credit order. A name
  that is empty (such as an unset site author) is left out, and a part with no named author gets
  no "By", never an empty one.
- **One person is named once** in the Contributors line, even when credited under two ids. A
  legacy post's default site-author credit and a registry credit with the same name are the same
  person when their profile URLs agree or either has none (the owner co-writing a shared
  reflection under their registry id). Name matching applies only to that legacy credit: two
  distinct registry ids are always two people, even with the same name and URL (or none), since
  the registry is where people are told apart. A namesake with a different profile URL keeps their
  own place.
- **Names are plain, escaped text.** The series never links a name or marks it up as a post author
  (`h-card`, `rel="author"`), whether or not the contributor has a profile URL; each post's own
  byline keeps doing that. An unknown contributor already stops the load, and a name the portable
  copy cannot carry faithfully already stops the build, so the series adds no new way for a value
  to reach a page.
- **Ordering, URLs and canonical links do not change.** The credits are extra text inside the
  existing links and list items; the order, hrefs, `rel="prev"`/`rel="next"`, `aria-current`, the
  native `details` disclosure and the landmark label stay as they were. Nothing needs JavaScript.
  Because the credit sits inside each link, a link's accessible name says whose part it leads to.

## Consequences

- Contributor profile pages remain out of scope. Feeds and portable output state the series context
  separately ([ADR 0041](0041-collaborative-series-context-in-feeds-and-portable-output.md)).
- A site that already had a multi-author post in a series sees that series start naming authors.
  That is the intended reading of "collaborative work"; nothing else on the site changes.
