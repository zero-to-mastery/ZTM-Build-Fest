# SEO and answer discovery

open.blog produces crawlable semantic HTML first. Every public post also gets a canonical
URL, description, Open Graph metadata, visible author byline, `BlogPosting` JSON-LD, publish
and update dates, topic tags, RSS and JSON feeds, and a sitemap. Recipe posts add matching
`Recipe` data. Research posts use `ScholarlyArticle`, can expose DOI, license, and bounded
reference links, and emit the minimum Google-documented Highwire title, author, and date
tags when an actual author resolves. Optional work-credit sidecars publish ordered authors
and secondary contributors consistently across visible HTML, structured data, and feeds.
These foundations matter to both conventional
search and AI-assisted search; no markup guarantees indexing or an AI citation.

Research output does not infer a journal, publisher, peer-review status, authority, or claim
support. The profile and its Evidence Studio are structural publishing tools; see
[Research posts and Evidence Studio](research-profile.md).

## Before publishing

1. Set the real public `url`, a specific site `title` and `description`, and the author's
   public `name` and `url` in `openblog.json`. Add verified profile URLs to
   `author.sameAs`; they are included in the author's structured identity. For shared work,
   add a contributor registry and adjacent credit sidecar as described in
   [Writing content](content.md#work-specific-credits).
2. Write a descriptive post title and a 50–180 character description that states the answer
   or benefit plainly. The editor and build warn when metadata deserves another look.
3. Add specific tags, descriptive H2/H3 section headings, and meaningful alternative text
   for cover images. Keep the important answer in visible text rather than only an image,
   video, or script.
4. Use `updated` when a material revision changes the answer. Use `canonical` only when a
   different URL is the original version.
5. Build and inspect the warnings. After deployment, validate representative posts with a
   structured-data validator and submit `/sitemap.xml` to the search consoles you use.

Google documents that its AI search features use the same core SEO requirements and do not
need special AI files or schema. The generated `/llms.txt` and `/llms-full.txt` are therefore
supplementary text-first discovery surfaces, not substitutes for good HTML, internal links,
or the sitemap.

## Decide what AI crawlers may do

The `seo` configuration keeps answer-search access separate from training access:

```jsonc
"seo": {
  "aiSearch": true,
  "aiTraining": false
}
```

`aiSearch` controls OAI-SearchBot, Claude-SearchBot, and PerplexityBot. `aiTraining`
controls GPTBot, ClaudeBot, and Google-Extended. The generated `robots.txt` still allows
ordinary search crawlers. Robots directives are voluntary crawl policy, not security; do
not publish private material and expect this file to protect it.

Provider references: [OpenAI crawlers](https://developers.openai.com/api/docs/bots),
[Anthropic crawlers](https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler),
[Perplexity crawlers](https://docs.perplexity.ai/docs/resources/perplexity-crawlers), and
[Google AI features](https://developers.google.com/search/docs/appearance/ai-features).

## Measure machine access

When the built-in server hosts the site, the Analytics tab reports successful requests from
the documented OpenAI, Anthropic, and Perplexity tokens by agent, purpose, and path. These
counts remain separate from human views and uniques. Only aggregate stable labels are
stored; addresses and raw user-agent headers are not.

The labels are claims because any client can copy a user-agent string. Use a CDN's verified
bot signal or provider-published IP ranges when identity must be proven. On a static host,
inspect the host or CDN request logs because the open.blog process never sees those fetches.
