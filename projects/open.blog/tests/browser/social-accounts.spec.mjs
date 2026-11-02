import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// Connected social accounts in Admin (ADR 0301, #366), from the real binary and the real Admin Studio, against a
// scripted stand-in for the hosted social function. No provider is ever contacted: the page only ever builds a
// link to the provider and the test never follows it.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const KEY = `adm_${randomBytes(24).toString("hex")}`;
const TOKEN = "AQX-must-never-reach-the-page";
const LONG = "Lantern".repeat(14);
let root;
let hosted;
let hostedPort;
let configured;
let plain;
const state = { accounts: [], connections: [], seen: [] };

const freePort = async () => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
};

const uuid = (() => {
  let n = 0;
  return () => `${String(++n).padStart(8, "0")}-0000-4000-8000-000000000000`;
})();

// The hosted function, as far as Admin can tell: it checks the key and the actor, and answers in the shapes
// of netlify/functions/social.mjs. Extra fields (a token) are included on purpose; Admin must drop them.
function handleHosted(request, response, body) {
  const url = new URL(request.url, "http://127.0.0.1");
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname.startsWith("/__")) {
    const payload = body ? JSON.parse(body) : {};
    if (url.pathname === "/__reset") Object.assign(state, { accounts: [], connections: [], seen: [] });
    if (url.pathname === "/__authorize") {
      const pending = state.connections.find((c) => c.status === "pending" && !c.reauthAccountId);
      Object.assign(pending, {
        status: "authorized",
        grantedScopes: ["openid", "profile", "w_member_social"],
        destinations: [
          { id: "urn:li:person:abc", kind: "member", name: "Ada Lovelace", eligible: true, reason: null },
          { id: "urn:li:organization:7", kind: "organization", name: LONG, eligible: false, reason: "missing-scope" },
        ],
        notes: [{ code: "organizations-not-approved", text: "LinkedIn refused the organization lookup. The app is probably not approved for the Community Management API; no organization is offered." }],
      });
    }
    if (url.pathname === "/__health") state.accounts.find((a) => a.id === payload.id).health = payload.health;
    if (url.pathname === "/__reauthorized") {
      const pending = state.connections.find((c) => c.status === "pending" && c.reauthAccountId);
      pending.status = "completed";
      Object.assign(state.accounts.find((a) => a.id === pending.reauthAccountId), { health: "ok", status: "connected" });
    }
    return send(200, {});
  }
  const actor = request.headers["x-openblog-actor"];
  state.seen.push({ method: request.method, path: url.pathname, actor, authorized: request.headers.authorization === `Bearer ${KEY}` });
  if (request.headers.authorization !== `Bearer ${KEY}` || actor !== "writer") return send(401, { error: "unauthorized", message: "Not authorized." });
  const route = url.pathname.replace(/^\/api\/social\/?/, "");
  const input = body ? JSON.parse(body) : {};
  if (request.method === "GET" && route === "status") {
    return send(200, {
      enabled: true,
      problems: [],
      providers: [
        { provider: "linkedin", label: "LinkedIn", redirectUri: "https://blog.example.com/api/social/callback/linkedin", version: "202510", scopes: ["openid", "profile", "w_member_social"], requiredScopes: ["openid", "profile", "w_member_social"], organizations: false, pkce: false, clientSecret: TOKEN },
        { provider: "facebook", label: "Facebook", redirectUri: "https://blog.example.com/api/social/callback/facebook", version: "v23.0", scopes: ["pages_show_list", "pages_manage_posts"], requiredScopes: ["pages_show_list", "pages_manage_posts"], organizations: false, pkce: false },
      ],
    });
  }
  if (request.method === "GET" && route === "accounts") return send(200, { accounts: state.accounts.map((a) => ({ ...a, accessToken: TOKEN })) });
  if (request.method === "GET" && route === "connections") return send(200, { connections: state.connections });
  if (request.method === "POST" && route === "connections") {
    const connection = { id: uuid(), provider: input.provider, status: "pending", expiresAt: new Date(Date.now() + 600000).toISOString(), createdAt: new Date().toISOString(), createdBy: "writer", reauthAccountId: null, requestedScopes: [], grantedScopes: [], errorCode: null, message: null, destinations: [], notes: [] };
    state.connections.unshift(connection);
    return send(201, { connection, authorizeUrl: `https://www.${input.provider}.com/oauth/v2/authorization?client_id=x&state=opaque` });
  }
  let match = /^connections\/([^/]+)\/select$/.exec(route);
  if (match) {
    const connection = state.connections.find((c) => c.id === match[1]);
    const destination = connection.destinations.find((d) => d.id === input.destination);
    connection.status = "completed";
    const account = { id: uuid(), provider: connection.provider, kind: destination.kind, externalId: destination.id, displayName: destination.name, status: "connected", health: "ok", connectedBy: "writer", createdAt: "2026-10-29T10:00:00Z", updatedAt: "2026-10-29T10:00:00Z", disconnectedAt: null, credential: { status: "active", accessExpiresAt: "2026-12-28T10:00:00Z", refreshExpiresAt: "2027-10-29T10:00:00Z", scopes: connection.grantedScopes, lastRefreshedAt: null } };
    state.accounts.unshift(account);
    return send(201, { account, credential: {} });
  }
  match = /^connections\/([^/]+)\/cancel$/.exec(route);
  if (match) {
    const connection = state.connections.find((c) => c.id === match[1]);
    connection.status = "canceled";
    return send(200, { connection });
  }
  match = /^accounts\/([^/]+)\/(reconnect|disconnect)$/.exec(route);
  if (match) {
    const account = state.accounts.find((a) => a.id === match[1]);
    if (match[2] === "disconnect") {
      Object.assign(account, { status: "disconnected", health: "disconnected", disconnectedAt: "2026-10-29T12:00:00Z", credential: null });
      return send(200, { account });
    }
    const connection = { id: uuid(), provider: account.provider, status: "pending", expiresAt: new Date(Date.now() + 600000).toISOString(), createdAt: new Date().toISOString(), createdBy: "writer", reauthAccountId: account.id, requestedScopes: [], grantedScopes: [], errorCode: null, message: null, destinations: [], notes: [] };
    state.connections.unshift(connection);
    return send(201, { connection, authorizeUrl: `https://www.${account.provider}.com/oauth/v2/authorization?state=again` });
  }
  return send(404, { error: "not-found", message: "Not found." });
}

async function startAdmin(name, environment) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), `openblog-social-${name}-`));
  mkdirSync(join(dir, "content", "posts"), { recursive: true });
  writeFileSync(join(dir, "content", "posts", "one.md"), "---\ntitle: One\ndate: 2026-10-01\n---\nA post.\n");
  writeFileSync(join(dir, "openblog.json"), JSON.stringify({ title: "Social", url: "https://social.example.org", author: { name: "Site Author" } }));
  execFileSync(binary, ["user", "add", "writer", "--root", dir], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });
  const env = { ...process.env, ...environment };
  if (!environment.OPENBLOG_SOCIAL_ENDPOINT) {
    delete env.OPENBLOG_SOCIAL_ENDPOINT;
    delete env.OPENBLOG_SOCIAL_ADMIN_KEY;
  }
  const child = spawn(binary, ["serve", "--admin", "--root", dir, "--port", String(port)], { cwd: repository, stdio: "pipe", env });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const origin = `http://127.0.0.1:${port}`;
  await expect(async () => {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
  return { child, dir, origin };
}

test.beforeAll(async () => {
  hosted = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => handleHosted(request, response, body));
  });
  hosted.listen(0, "127.0.0.1");
  await once(hosted, "listening");
  hostedPort = hosted.address().port;
  configured = await startAdmin("on", { OPENBLOG_SOCIAL_ENDPOINT: `http://127.0.0.1:${hostedPort}/api/social`, OPENBLOG_SOCIAL_ADMIN_KEY: KEY });
  plain = await startAdmin("off", {});
  root = [configured.dir, plain.dir];
});

test.afterAll(async () => {
  for (const server of [configured, plain]) {
    if (server?.child && server.child.exitCode === null) {
      const stopped = once(server.child, "exit");
      server.child.kill();
      await stopped;
    }
  }
  await new Promise((done) => hosted?.close(done) || done());
  for (const dir of root || []) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold a file */ }
  }
});

test.beforeEach(async ({ page }) => {
  await fetch(`http://127.0.0.1:${hostedPort}/__reset`, { method: "POST", body: "{}" });
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
  });
});

async function openSocial(page, server, hash = "#/social") {
  await page.goto(`${server.origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${server.origin}/admin/${hash}`);
}

const authorize = () => fetch(`http://127.0.0.1:${hostedPort}/__authorize`, { method: "POST", body: "{}" });
const sideways = (page, selector) => page.locator(selector).evaluate((node) => ({ region: node.scrollWidth - node.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }));

test("without social settings the page says so, offers nothing, and the navigation does not mention it", async ({ page }) => {
  await openSocial(page, plain, "#/overview");
  await expect(page.locator('[data-action="logout"]')).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin tools" }).getByRole("link", { name: "Social accounts" })).toHaveCount(0);
  await page.goto(`${plain.origin}/admin/#/social`);
  await expect(page.getByRole("heading", { level: 2, name: "Social accounts" })).toBeVisible();
  await expect(page.locator("[data-social-off]")).toContainText("Social publishing is not set up");
  await expect(page.locator('[data-action="social-connect"]')).toHaveCount(0);
  // The browser never talks to Supabase or the function: the only network it uses is Admin.
  const status = await page.evaluate(async () => (await fetch("/admin/api/social/accounts", { credentials: "same-origin" })).status);
  expect(status).toBe(404);
});

test("connect LinkedIn: review permissions, wait for the provider, choose by keyboard, and see the account", async ({ page }) => {
  await openSocial(page, configured, "#/overview");
  const nav = page.getByRole("navigation", { name: "Admin tools" });
  await nav.getByRole("link", { name: "Social accounts" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Social accounts" })).toBeVisible();
  const linkedin = page.locator('li[data-provider="linkedin"]');
  await linkedin.locator("summary").click();
  await expect(linkedin).toContainText("Post as you");
  await expect(linkedin.locator("[data-social-redirect]")).toHaveText("https://blog.example.com/api/social/callback/linkedin");
  await linkedin.getByRole("button", { name: "Connect LinkedIn" }).click();
  const proceed = page.getByRole("link", { name: /Continue to LinkedIn/ });
  await expect(proceed).toBeFocused();
  await expect(proceed).toHaveAttribute("href", /^https:\/\/www\.linkedin\.com\//);
  await expect(proceed).toHaveAttribute("target", "_blank");
  await expect(proceed).toHaveAttribute("rel", "noopener noreferrer");
  expect(state.seen.filter((call) => call.method === "POST").every((call) => call.authorized && call.actor === "writer")).toBe(true);

  await authorize();
  await page.getByRole("button", { name: "I have finished, check now" }).click();
  const group = page.getByRole("group", { name: "Choose where LinkedIn posts may go" });
  await expect(group).toBeVisible();
  const member = group.getByRole("radio", { name: /Ada Lovelace/ });
  const organization = group.locator("input[disabled]");
  await expect(organization).toBeDisabled();
  await expect(page.locator("li[data-eligible='false']")).toContainText("A permission needed to post here was not granted.");
  await expect(page.locator("[data-note]")).toContainText("LinkedIn refused the organization lookup");
  // Keyboard only: into the group, choose, then Tab to the button and press Enter.
  await member.focus();
  await page.keyboard.press("Space");
  await expect(member).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Connect this destination" })).toBeFocused();
  await page.keyboard.press("Enter");
  const card = page.locator("li[data-account]");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Ada Lovelace");
  await expect(card.locator("[data-health]")).toHaveText(/Connected/);
  await expect(page.locator("[data-social-status]")).toContainText("Ada Lovelace is connected.");
  expect(await page.locator("body").innerText()).not.toContain(TOKEN);
  expect(await page.content()).not.toContain(TOKEN);
});

test("an account that needs reconnecting says so, reconnects, and disconnect asks first", async ({ page }) => {
  await openSocial(page, configured);
  await page.locator('li[data-provider="linkedin"]').getByRole("button", { name: "Connect LinkedIn" }).click();
  await expect(page.getByRole("link", { name: /Continue to LinkedIn/ })).toBeFocused();
  await authorize();
  await page.getByRole("button", { name: "I have finished, check now" }).click();
  await page.getByRole("radio", { name: /Ada Lovelace/ }).check();
  await page.getByRole("button", { name: "Connect this destination" }).click();
  const card = page.locator("li[data-account]");
  await expect(card).toHaveCount(1);
  await fetch(`http://127.0.0.1:${hostedPort}/__health`, { method: "POST", body: JSON.stringify({ id: state.accounts[0].id, health: "needs-reauth" }) });
  await page.reload();
  await expect(card.locator("[data-health]")).toHaveText(/Needs reconnecting/);
  await expect(card.locator("[data-social-reauth]")).toContainText("signing in as the same account");
  await card.getByRole("button", { name: "Reconnect Ada Lovelace" }).click();
  await expect(page.getByRole("link", { name: /Continue to LinkedIn/ })).toBeFocused();
  await fetch(`http://127.0.0.1:${hostedPort}/__reauthorized`, { method: "POST", body: "{}" });
  await page.getByRole("button", { name: "I have finished, check now" }).click();
  await expect(card.locator("[data-health]")).toHaveText(/Connected/);

  // Disconnect: the question comes first and can be declined.
  await card.getByRole("button", { name: "Disconnect Ada Lovelace" }).click();
  const question = page.getByRole("group", { name: "Confirm disconnecting Ada Lovelace" });
  await expect(question).toContainText("Its stored tokens are erased");
  await expect(question.locator("[data-confirm-text]")).toBeFocused();
  await question.getByRole("button", { name: "Keep it connected" }).click();
  await expect(question).toHaveCount(0);
  expect(state.seen.some((call) => call.path.endsWith("/disconnect"))).toBe(false);
  await card.getByRole("button", { name: "Disconnect Ada Lovelace" }).click();
  await page.getByRole("button", { name: "Disconnect Ada Lovelace", exact: true }).last().click();
  await expect(card.locator("[data-health]")).toHaveText(/Disconnected/);
  await expect(page.locator("[data-social-status]")).toContainText("Its stored tokens were erased.");
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("on a phone the page has no sideways scroll, even with a very long name and id", async ({ page }) => {
  for (const width of [320, 360, 414]) {
    await page.setViewportSize({ width, height: 800 });
    await fetch(`http://127.0.0.1:${hostedPort}/__reset`, { method: "POST", body: "{}" });
    await openSocial(page, configured);
    await page.locator('li[data-provider="linkedin"]').getByRole("button", { name: "Connect LinkedIn" }).click();
    await expect(page.getByRole("link", { name: /Continue to LinkedIn/ })).toBeVisible();
    await authorize();
    await page.getByRole("button", { name: "I have finished, check now" }).click();
    await expect(page.getByRole("group", { name: "Choose where LinkedIn posts may go" })).toBeVisible();
    let overflow = await sideways(page, "ob-social-accounts");
    expect(overflow.region, `choosing at ${width}px`).toBeLessThanOrEqual(1);
    expect(overflow.page, `page at ${width}px`).toBeLessThanOrEqual(1);
    await page.getByRole("radio", { name: /Ada Lovelace/ }).check();
    await page.getByRole("button", { name: "Connect this destination" }).click();
    await expect(page.locator("li[data-account]")).toHaveCount(1);
    state.accounts[0].displayName = LONG;
    state.accounts[0].externalId = `urn:li:organization:${"9".repeat(120)}`;
    await page.reload();
    await expect(page.locator("li[data-account]")).toContainText(LONG);
    overflow = await sideways(page, "ob-social-accounts");
    expect(overflow.region, `accounts at ${width}px`).toBeLessThanOrEqual(1);
    expect(overflow.page, `page at ${width}px`).toBeLessThanOrEqual(1);
    // Every control is a comfortable touch target.
    const heights = await page.locator("ob-social-accounts button, ob-social-accounts a.oba-btn").evaluateAll((nodes) => nodes.filter((n) => n.offsetParent).map((n) => n.getBoundingClientRect().height));
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(43);
  }
});
