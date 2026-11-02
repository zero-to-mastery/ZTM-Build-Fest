import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "../../netlify/functions/engagement.mjs";
import { removeTree } from "./teardown.mjs";

// Comment captcha in a real browser (epic #296, task #312). The built site is served statically.
// The real engagement function handler answers /api/comments, wired in at the network layer with
// a fake database and a fake Turnstile `siteverify` that follows Cloudflare's published test
// secrets (always-pass 1x00..., always-fail 2x00...). The provider script is a stub that hands
// out Turnstile's dummy test token, so nothing leaves the machine.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENDPOINT = "https://captcha.example/api";
const PASS_SECRET = "1x0000000000000000000000000000000AA";
const FAIL_SECRET = "2x0000000000000000000000000000000AA";
const SITE_KEY = "1x00000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const SIGNING = "browser-spec-signing-value-".repeat(2);
const POST = "---\ntitle: Post\ndate: 2026-10-20\n---\nA post.";

const sites = {};

function serve(root) {
  const server = createServer((req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      const file = join(root, "dist", path.endsWith("/") ? `${path}index.html` : path);
      res.setHeader("Content-Type", extname(file) === ".js" ? "text/javascript" : extname(file) === ".css" ? "text/css" : "text/html");
      res.end(readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, origin: `http://127.0.0.1:${server.address().port}`, root })));
}

function build(name, engagement) {
  const root = mkdtempSync(join(tmpdir(), `openblog-captcha-${name}-`));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Captcha", url: "https://blog.example", postPath: "/{slug}/", engagement: { enabled: true, endpoint: ENDPOINT, ...engagement } }));
  mkdirSync(join(root, "content/posts"), { recursive: true });
  writeFileSync(join(root, "content/posts/post.md"), POST);
  execFileSync(join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog"), ["build", "--root", root], { stdio: "pipe" });
  return serve(root);
}

test.beforeAll(async () => {
  sites.on = await build("on", { captcha: { provider: "turnstile", siteKey: SITE_KEY, scope: "session" } });
  sites.off = await build("off", {});
});
test.afterAll(async () => {
  for (const site of Object.values(sites)) {
    await new Promise((done) => site.server?.close(done));
    removeTree(site.root);
  }
});

/** The real handler behind the page's network, with a movable clock and a fake database/provider. */
async function backend(page, site, { secret = PASS_SECRET, provider = "turnstile", blocked = false, mode = "auto" } = {}) {
  const state = { loads: 0, verifications: [], stored: [], posts: [], blocked, clock: Date.now() };
  const handler = createHandler({
    env: {
      SUPABASE_URL: "https://db.example", SUPABASE_SECRET_KEY: "private-database-key", OPENBLOG_SITE_ID: "spec",
      OPENBLOG_SITE_ORIGIN: site.origin, OPENBLOG_ADMIN_API_KEY: "admin", OPENBLOG_ANALYTICS_SALT: "salt",
      OPENBLOG_CAPTCHA_PROVIDER: provider, OPENBLOG_TURNSTILE_SECRET: secret, OPENBLOG_CAPTCHA_SESSION_SECRET: SIGNING,
    },
    now: () => new Date(state.clock),
    siteFetchImpl: async () => ({ ok: true, json: async () => ({ "/post/": "open" }) }),
    fetchImpl: async (url, options = {}) => {
      if (url.includes("siteverify")) {
        const form = new URLSearchParams(options.body);
        state.verifications.push(form.get("response"));
        const ok = form.get("secret") === PASS_SECRET && form.get("response") === DUMMY_TOKEN;
        return { ok: true, json: async () => (ok ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] }) };
      }
      if (url.includes("consume_rate_limit")) return { ok: true, json: async () => ({ allowed: true }) };
      if (options.method === "POST" && url.includes("/openblog_comments")) { state.stored.push(JSON.parse(options.body)); return { ok: true, json: async () => [{ id: `c${state.stored.length}` }] }; }
      return { ok: true, json: async () => [] };
    },
  });
  await page.addInitScript((value) => { window.__mode = value; }, mode);
  await page.route("https://challenges.cloudflare.com/**", (route) => {
    state.loads++;
    if (state.blocked) return route.abort();
    return route.fulfill({ contentType: "text/javascript", body: `
      window.turnstile = {
        render(container, options) {
          window.challengeOptions = options;
          const finish = () => options.callback("${DUMMY_TOKEN}");
          if (window.__mode === "interactive") {
            options["before-interactive-callback"]();
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Verify human";
            button.onclick = () => { options["after-interactive-callback"](); finish(); };
            container.replaceChildren(button);
          } else setTimeout(finish, 20);
          return "widget";
        },
        reset() { window.turnstile.render(document.querySelector(".ob-comments-captcha"), window.challengeOptions); },
        remove() { document.querySelector(".ob-comments-captcha")?.replaceChildren(); },
      };` });
  });
  await page.route(`${ENDPOINT}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") state.posts.push(request.postDataJSON());
    const reply = await handler({
      path: url.pathname, httpMethod: request.method(), headers: { ...request.headers(), "x-nf-client-connection-ip": "203.0.113.7" },
      queryStringParameters: Object.fromEntries(url.searchParams), body: request.postData() || "",
    });
    await route.fulfill({ status: reply.statusCode, headers: reply.headers || {}, body: reply.body });
  });
  return state;
}

const fill = async (page, body = "A thoughtful comment") => {
  await page.getByLabel("Name", { exact: true }).fill("Reader");
  await page.getByLabel("Comment", { exact: true }).fill(body);
};
const status = (page) => page.locator(".ob-comments-status");
const submit = (page) => page.getByRole("button", { name: "Submit for review" });

test("first comment is challenged (keyboard), the second is not, and nothing loads before interaction", async ({ page }) => {
  const state = await backend(page, sites.on, { mode: "interactive" });
  await page.goto(`${sites.on.origin}/post/`);
  await expect(status(page)).toHaveText("No approved comments yet.");
  expect(state.loads).toBe(0);
  await expect(page.locator(".ob-comments-captcha-note")).toContainText("Cloudflare Turnstile");

  await page.getByLabel("Name", { exact: true }).focus();
  await expect(status(page)).toContainText("complete the human check");
  expect(state.loads).toBe(1);
  await expect(page.locator(".ob-comments-captcha")).toBeFocused();
  await page.getByLabel("Name", { exact: true }).fill("Reader");
  await page.getByLabel("Comment", { exact: true }).fill("First draft");
  await page.getByRole("button", { name: "Verify human" }).focus();
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Verified. You can submit your comment.");
  await expect(submit(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Comment submitted for moderation.");
  expect(state.posts[0].captchaToken).toBe(DUMMY_TOKEN);
  expect(state.verifications).toEqual([DUMMY_TOKEN]);
  expect(state.stored).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("openblog.commentPass.v1:")).length)).toBe(1);

  await page.reload();
  await fill(page, "Second draft");
  await submit(page).click();
  await expect(status(page)).toHaveText("Comment submitted for moderation.");
  expect(state.loads).toBe(1);
  expect(state.posts[1].captchaPass).toBeTruthy();
  expect(state.posts[1].captchaToken).toBeUndefined();
  expect(state.verifications).toHaveLength(1);
  expect(state.stored).toHaveLength(2);
});

test("an expired pass triggers one fresh challenge and one retry that keeps the text", async ({ page }) => {
  const state = await backend(page, sites.on);
  await page.goto(`${sites.on.origin}/post/`);
  await fill(page, "First draft");
  await expect(status(page)).toHaveText("Verified. You can submit your comment.");
  await submit(page).click();
  await expect(status(page)).toHaveText("Comment submitted for moderation.");

  state.clock += 31 * 60 * 1000;
  await page.reload();
  await page.getByLabel("Name", { exact: true }).fill("Reader");
  await page.getByLabel("Comment", { exact: true }).fill("Drafted after the pass expired");
  await submit(page).click();
  await expect(status(page)).toHaveText("Comment submitted for moderation.", { timeout: 15000 });
  const expiredSends = state.posts.filter((post) => post.body === "Drafted after the pass expired");
  expect(expiredSends).toHaveLength(2);
  expect(expiredSends[0].captchaPass).toBeTruthy();
  expect(expiredSends[1].captchaToken).toBe(DUMMY_TOKEN);
  expect(state.stored.filter((post) => post.body === "Drafted after the pass expired")).toHaveLength(1);
  expect(state.verifications).toHaveLength(2);
});

test("a server rejection keeps the draft, retries once, then stops", async ({ page }) => {
  const state = await backend(page, sites.on, { secret: FAIL_SECRET });
  await page.goto(`${sites.on.origin}/post/`);
  await fill(page, "These words must survive");
  await expect(status(page)).toHaveText("Verified. You can submit your comment.");
  await submit(page).click();
  await expect(status(page)).not.toHaveText("Submitting…");
  await expect(page.getByLabel("Comment", { exact: true })).toHaveValue("These words must survive");
  await expect.poll(() => state.posts.length).toBeLessThanOrEqual(2);
  expect(state.stored).toHaveLength(0);
  await expect(page.getByLabel("Comment", { exact: true })).toHaveValue("These words must survive");
});

test("a blocked provider explains itself, offers Retry and keeps the text", async ({ page }) => {
  const state = await backend(page, sites.on, { blocked: true });
  await page.goto(`${sites.on.origin}/post/`);
  await fill(page, "Keep these words");
  await expect(page.getByRole("button", { name: "Retry verification" })).toBeVisible();
  await expect(status(page)).toContainText("could not load");
  await expect(page.getByLabel("Comment", { exact: true })).toHaveValue("Keep these words");
  await submit(page).click();
  await expect(status(page)).toContainText("could not load");
  expect(state.posts).toHaveLength(0);
  state.blocked = false;
  await page.getByRole("button", { name: "Retry verification" }).focus();
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Verified. You can submit your comment.");
  await submit(page).click();
  await expect(status(page)).toHaveText("Comment submitted for moderation.");
  expect(state.stored[0].body).toBe("Keep these words");
});

test("the direct API refuses an unverified comment and a forged pass before storing anything", async ({ page }) => {
  const state = await backend(page, sites.on);
  await page.goto(`${sites.on.origin}/post/`);
  for (const extra of [{}, { captchaPass: "forged.pass" }]) {
    const result = await page.evaluate(async ({ endpoint, extra }) => {
      const response = await fetch(`${endpoint}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "/post/", authorName: "Bot", body: "Spam", ...extra }) });
      return { status: response.status, body: await response.json() };
    }, { endpoint: ENDPOINT, extra });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("captcha_required");
  }
  expect(state.stored).toHaveLength(0);
});

test("captcha off: same form, no provider request, no captcha fields", async ({ page }) => {
  const state = await backend(page, sites.off, { provider: "off" });
  await page.goto(`${sites.off.origin}/post/`);
  await expect(status(page)).toHaveText("No approved comments yet.");
  await expect(page.locator("ob-comments")).not.toHaveAttribute("captcha-provider", /.*/);
  await expect(page.locator(".ob-comments-captcha, .ob-comments-captcha-note")).toHaveCount(0);
  await fill(page);
  await submit(page).click();
  await expect(status(page)).toHaveText("Comment submitted for moderation.");
  expect(state.loads).toBe(0);
  expect(state.posts).toEqual([{ path: "/post/", authorName: "Reader", body: "A thoughtful comment" }]);
});

test("no JavaScript keeps the existing fallback", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${sites.on.origin}/post/`);
  await expect(page.locator("ob-comments")).toContainText("Comments require JavaScript.");
  await context.close();
});

test("the challenge fits a 320px screen without sideways scrolling", async ({ page }) => {
  await backend(page, sites.on, { mode: "interactive" });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${sites.on.origin}/post/`);
  await page.getByLabel("Name", { exact: true }).focus();
  await expect(page.locator(".ob-comments-captcha")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});
