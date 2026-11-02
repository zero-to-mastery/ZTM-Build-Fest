/**
 * Create or update a DEV article from the newest item in an open.blog JSON Feed.
 * New articles are always drafts. Updating an existing article preserves its current
 * published state because the update payload deliberately omits `published`.
 */

const siteUrl = required("SITE_URL").replace(/\/$/, "");
const apiKey = required("DEVTO_API_KEY");
const requestedUrl = process.env.POST_URL?.trim();

const headers = {
  "api-key": apiKey,
  Accept: "application/vnd.forem.api-v1+json",
  "Content-Type": "application/json",
  "User-Agent": "open.blog cross-publisher",
};

const feedResponse = await fetch(`${siteUrl}/feed.json`);
if (!feedResponse.ok) {
  throw new Error(`Could not read ${siteUrl}/feed.json (${feedResponse.status})`);
}

const feed = await feedResponse.json();
const item = requestedUrl
  ? feed.items?.find((candidate) => candidate.url === requestedUrl)
  : feed.items?.[0];

if (!item?.url || !item.title || !item.content_html) {
  throw new Error(
    requestedUrl
      ? `POST_URL was not found in the JSON Feed: ${requestedUrl}`
      : "The JSON Feed has no publishable item",
  );
}

const canonicalResponse = await fetch(item.url, { redirect: "follow" });
if (!canonicalResponse.ok) {
  throw new Error(`Canonical URL is not live: ${item.url} (${canonicalResponse.status})`);
}

const articlesResponse = await fetch(
  "https://dev.to/api/articles/me/all?per_page=1000",
  { headers },
);
if (!articlesResponse.ok) {
  throw new Error(`Could not list DEV articles (${articlesResponse.status})`);
}

const articles = await articlesResponse.json();
const existing = articles.find((article) => article.canonical_url === item.url);
const article = {
  title: item.title,
  body_markdown: item.content_html,
  canonical_url: item.url,
  description: item.summary ?? "",
  tags: (item.tags ?? []).slice(0, 4).join(","),
};

if (!existing) article.published = false;

const endpoint = existing
  ? `https://dev.to/api/articles/${existing.id}`
  : "https://dev.to/api/articles";
const response = await fetch(endpoint, {
  method: existing ? "PUT" : "POST",
  headers,
  body: JSON.stringify({ article }),
});

if (!response.ok) {
  throw new Error(`DEV ${existing ? "update" : "create"} failed (${response.status}): ${await response.text()}`);
}

const saved = await response.json();
console.log(`${existing ? "Updated" : "Created draft"}: ${saved.url ?? saved.id}`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
