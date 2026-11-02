# Showing your posts on another site

Many people run a blog next to a portfolio, a company site, or a profile page and want
the newest posts to appear there. open.blog publishes three machine-readable lists for
that; nothing on the blog side needs configuring.

## The latest-posts JSON

`/api/blog.json` is the simplest. It holds the four newest posts:

```json
{
  "schemaVersion": 1,
  "posts": [
    { "title": "Rust enums and match", "date": "2026-10-21T04:15:10Z", "link": "https://example.com/posts/rust-enums-and-match/" }
  ]
}
```

Fetch it from your other site and render the list. In a browser:

```html
<ul id="latest"></ul>
<script type="module">
  const { posts } = await (await fetch("https://blog.example.com/api/blog.json")).json();
  document.getElementById("latest").replaceChildren(...posts.map((p) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = p.link;
    a.textContent = p.title;
    li.append(a, ` (${new Date(p.date).toLocaleDateString()})`);
    return li;
  }));
</script>
```

`openblog serve` sends `Access-Control-Allow-Origin: *` for this file and the feeds, so a
browser on another site can fetch them. Most static hosts do the same for public files; if
yours does not, fetch the file from your other site's server instead of the browser.
Turn the file off with `"feeds": { "portfolioSnapshot": false }`.

## RSS and JSON Feed

`/rss.xml` (RSS 2.0) and `/feed.json` (JSON Feed 1.1) list the newest twenty posts with
titles, dates, links, tags, covers, and, by default, the full HTML of each post. Feed
readers, newsletter tools, and most "latest posts" widgets accept either. The number of
posts and whether full content is included are set under `feeds` in `openblog.json`.
Posts with explicit work credits repeat their actual authors in RSS and expose an ordered
JSON Feed item `authors` array. The feed-level author remains the site owner.

The RSS items use the post address as the `guid`, so a reader never shows a post twice
when its title changes.

Full-content feeds derive static HTML from the shared portable projection, not the native
component markup. JSON Feed also includes useful plain text (including code and link targets).
Quiz answers remain visible; execution and participation link back to the canonical article.
Relative body URLs resolve against that article, while a front-matter `canonical` pointing
elsewhere remains JSON Feed's `external_url`, not the item ID. RSS uses namespaced
`content:encoded`/`dc:creator`/`atom:link`; no provider payload fields enter either feed.
With `feeds.fullContent: false`, RSS retains its description and omits full content; JSON Feed
uses the same summary as `content_text` to satisfy its required-content contract without
exporting the body. IDs, dates, ordering, credits and cover URLs retain the same policy.

### Series in feeds

A part of a collaborative series (one that holds a post credited to two or more authors) also
states its series. Every other item is unchanged.

- The full content (and every portable copy) says "Part 2 in the series Letters" with a link to
  the series page, the part's authors and the series' contributors. It never states the number of
  parts, so a copy you syndicated does not change each time the series grows.
- RSS adds a `category` with the series name whose `domain` is the series index (`/series/`).
  The domain identifies the taxonomy; it does not link the series. A summary-only RSS item
  (`feeds.fullContent: false`) therefore names its series but has no series link, place or authors.
- JSON Feed adds an `_openblog` extension object, which readers that do not know it ignore:
  `about` (a link to this section) and `series`, with `title`, `url`, `part`, `parts` (the number
  of published parts), `authors` (this part's) and `contributors` (the whole series').

## Cross-posting

To republish a post on another platform (dev.to, Medium, Hashnode, a newsletter), either
let the platform import your RSS feed or paste the Markdown. On the copy, set the
canonical URL to the post's address on your blog so search engines credit the original.

The other way round, when a post was first published elsewhere, add `canonical:` to its
front matter here; the page then declares the original as canonical and shows a
"originally published at" note if you also set `sourceUrl:`.

## Comments, newsletters, and other embeds

Services that give you a snippet to paste (giscus or utterances comments, a newsletter
form, a tip jar, a different analytics provider) go into `snippets` in `openblog.json`:

```jsonc
"snippets": {
  "head": "",            // before </head> on every page
  "postFooter": "",      // at the end of every post, after related posts
  "bodyEnd": ""          // before </body> on every page
}
```

See [Sharing, views, analytics, and embeds](features.md) for the details.
