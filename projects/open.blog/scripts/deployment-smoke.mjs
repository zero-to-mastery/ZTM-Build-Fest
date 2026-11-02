import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export async function smoke({
  origin,
  adminOrigin,
  postPath,
  captcha = false,
  fetchImpl = fetch,
  log = console.log,
}) {
  const site = new URL(origin);
  const admin = new URL(adminOrigin);
  for (const url of [site, admin]) {
    assert.equal(url.protocol, "https:", "Smoke tests require HTTPS");
    assert.ok(!url.username && !url.password, "URLs must not contain credentials");
    assert.equal(url.pathname, "/", "Use an origin, not a URL path");
    assert.ok(!url.search && !url.hash, "Origins must not include query strings or fragments");
  }
  assert.ok(postPath.startsWith("/") && !postPath.startsWith("//"), "Post must be a root-relative path");
  const post = new URL(postPath, site);
  assert.equal(post.origin, site.origin);
  async function get(url, status, contentType) {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "openblog-deployment-smoke/1" },
    });
    assert.equal(response.status, status, `${new URL(url).pathname}: expected HTTP ${status}, got ${response.status}`);
    if (contentType) {
      assert.match(response.headers.get("content-type") || "", contentType, `${new URL(url).pathname}: unexpected content type`);
    }
    return response;
  }
  const home = await get(site, 200, /text\/html/i);
  const html = await home.text();
  const styles = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter(([tag]) => /\brel=["']stylesheet["']/i.test(tag))
    .map(([tag]) => tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
    .filter(Boolean);
  assert.ok(styles.length, "Homepage must link a stylesheet");
  for (const href of new Set(styles)) {
    const url = new URL(href.replaceAll("&amp;", "&"), site);
    assert.equal(url.origin, site.origin, "Expected same-origin site styles");
    await get(url, 200, /text\/css/i);
  }
  log("PASS homepage and linked stylesheets");
  const article = await get(post, 200, /text\/html/i);
  const articleHtml = await article.text();
  assert.match(articleHtml, /<article\b/i, "Post must contain an article");
  log("PASS representative post");

  for (const [path, destination] of [
    ["/admin", "/admin/"],
    ["/admin/", "/admin/"],
    ["/admin/admin.css", "/admin/admin.css"],
  ]) {
    const response = await get(new URL(path, site), 302);
    assert.equal(response.headers.get("location"), new URL(destination, admin).href, "Unexpected Admin redirect");
  }
  await get(new URL("/admin/", admin), 200, /text\/html/i);
  await get(new URL("/admin/admin.css", admin), 200, /text\/css/i);
  await get(new URL("/admin/admin.js", admin), 200, /javascript/i);
  log("PASS Admin redirect, login page, and assets (no authentication attempted)");

  const views = await get(new URL(`/api/views?path=${encodeURIComponent(post.pathname)}`, site), 200, /application\/json/i);
  assert.ok(Number.isFinite((await views.json()).views), "Expected numeric view count");
  const comments = await get(new URL(`/api/comments?path=${encodeURIComponent(post.pathname)}`, site), 200, /application\/json/i);
  assert.ok(Array.isArray((await comments.json()).comments), "Expected public comment array");
  await get(new URL("/api/admin/analytics?days=7", site), 401);
  await get(new URL("/api/admin/comments?status=pending", site), 401);
  log("PASS public engagement reads and protected moderation endpoints");
  if (captcha) {
    assert.match(articleHtml, /<ob-comments\b[^>]*\bcaptcha-provider="turnstile"[^>]*\bcaptcha-site-key="[^"]+"/, "The post must carry the public captcha attributes; enable engagement.captcha and rebuild");
    const refused = async (extra, what) => {
      const response = await fetchImpl(new URL("/api/comments", site), {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", Origin: site.origin },
        body: JSON.stringify({ path: post.pathname, authorName: "Deployment smoke", body: "Unverified captcha deployment check", ...extra }),
      });
      const result = await response.json().catch(() => ({}));
      assert.notEqual(response.status, 503, `Captcha is enabled but the function is misconfigured (${result.code || "no code"}): ${result.error || "no message"}`);
      assert.ok(response.status !== 202 && response.status !== 200, `A captcha-enabled site accepted ${what}; check OPENBLOG_CAPTCHA_PROVIDER on the function`);
      assert.equal(response.status, 403, `${what}: expected HTTP 403, got ${response.status}`);
      assert.equal(result.code, "captcha_required", `${what}: expected code captcha_required`);
    };
    await refused({}, "an unverified comment");
    await refused({ captchaPass: "forged.pass" }, "a forged pass");
    log("PASS unverified and forged captcha submissions refused");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [origin, adminOrigin, postPath] = process.argv.slice(2);
  if (!origin || !adminOrigin || !postPath) {
    console.error("Usage: node scripts/deployment-smoke.mjs <site-origin> <admin-origin> <post-path>");
    process.exitCode = 1;
  } else {
    try {
      await smoke({ origin, adminOrigin, postPath, captcha: process.argv.includes("--captcha") });
    } catch (error) {
      console.error(`Deployment smoke test failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
