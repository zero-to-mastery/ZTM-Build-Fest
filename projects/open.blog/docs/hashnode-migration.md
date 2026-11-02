# Migrating from Hashnode

Hashnode retired free access to its GraphQL API on 13 May 2026; every request now needs a
Pro plan on the publication. `openblog import hashnode` offers two sources so you can
migrate with or without Pro.

## Before you import

1. Create the blog and go into it:

   ```sh
   openblog init my-blog
   cd my-blog
   ```

   The import runs inside a blog folder (or with `--root my-blog`), because it reads
   `openblog.json` to know where posts and images go.

2. Decide your post addresses now, in `openblog.json`. Hashnode serves posts at
   `https://your-host/<slug>`. To keep every address identical, set:

   ```json
   "postPath": "/{slug}/"
   ```

   With any other `postPath`, the importer adds `aliases: ["/<slug>/"]` to each post so the
   old address redirects to the new one. If you change `postPath` to `/{slug}/` *after*
   importing, remove those `aliases:` lines; an alias that equals the post's own address
   fails the build.

## Without Pro: `--source public` (default)

```sh
openblog import hashnode yourname.hashnode.dev --limit 3   # trial run with three posts
openblog import hashnode yourname.hashnode.dev             # everything
```

Use the address readers see; a custom domain such as `blog.example.com` works the same.

It reads the pages your readers see:

1. `/sitemap.xml` (and its `?page=N` pages) lists every post URL.
2. Each post page carries schema.org metadata: title, publish and modified dates, cover
   image, description, and keywords.
3. Tags come from those keywords; when a page has none, its `/tag/` links are used. The
   series comes from the page's `/series/` link, and each series page lists its parts in
   reading order, which becomes `seriesOrder`.
4. The article body is converted from HTML back to Markdown (headings, fenced code with
   language, lists, tables, images, links).
5. Cover and body images are downloaded to `static/images/<slug>/` and rewritten to
   `/images/<slug>/...`, so the blog no longer depends on Hashnode's CDN. A dead image is
   reported and left pointing at its original URL; it never stops the import.

Output is `content/posts/<date>-<slug>.md` plus `content/series/<series>.md`. Each post
also gets `sourceUrl:` with its Hashnode address, shown as "Originally published at ..."
under the post. Keep it if the Hashnode blog stays up as a cross-post; delete the line
from the posts if you are shutting Hashnode down.

Hashnode tags that are really keyword dumps (over 40 characters, or containing `#`) are
dropped and listed in the report. Review the rest; many one-off tags make a long tags page.

Options:

| Option | Effect |
| --- | --- |
| `--limit <n>` | Import only the first n posts (newest first) |
| `--no-images` | Keep remote image URLs instead of downloading |
| `--delay <ms>` | Pause between requests (default 250) |
| `--overwrite` | Replace imported posts you have edited since the last run |

### Running it again

Re-running picks up new posts. A post file that already exists and differs from what the
importer would write, which includes any post you edited after the first run, is left
alone and listed in the report; pass `--overwrite` to replace such files. Series files are
never overwritten once they exist, so a `theme:` you added to one survives.

### Limits

This reads rendered HTML, so unusual Hashnode embeds (iframes, custom widgets) may convert
poorly, and a Hashnode redesign could change the page markup. Drafts are not public, so
they cannot be imported this way. Spot-check a few posts, especially tables and embeds.

## With Pro: `--source graphql`

```sh
openblog import hashnode yourname.hashnode.dev --source graphql --token <token>
```

Or put the token in the `HASHNODE_TOKEN` environment variable
(`export HASHNODE_TOKEN=...` in a Unix shell, `$env:HASHNODE_TOKEN = "..."` in
PowerShell). Uses `https://gql.hashnode.com` with your personal access token and returns
the original Markdown exactly, with the same output files and image handling. Two
differences from the public source: drafts can be included, and series order is not read,
so parts are ordered by date unless you add `seriesOrder` to the posts.

**This path is written against Hashnode's documented schema but has not been exercised,
because it needs a Pro account.** If it fails, the error message says why; the public
source remains available.

## After importing

```sh
openblog check     # validates every post, series, tag and theme
openblog serve     # preview at http://localhost:8080
openblog build     # writes dist/
```

Then deploy `dist/` (see [Deploying](deploy.md)). To keep a custom domain working, point it
at the new host and keep `"postPath": "/{slug}/"`. Stop the old Hashnode blog from serving
that domain first, or leave Hashnode on its `hashnode.dev` address and add `canonical:`
front matter to any post you keep cross-posted there.
