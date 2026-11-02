// The public privacy policy (#541, epic #527): the Google Play listing and
// the app link to /privacy.html, so the server must serve it, the offline
// shell must keep it, and it must stay a plain, accessible page that the
// Content-Security-Policy allows (no scripts, no inline styles).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createKinServer } from "./server.mjs";

const web = new URL("../web/", import.meta.url);

async function start(t) {
  // No database: the page needs none, and the project's own .kin-data stays untouched.
  const app = createKinServer({ port: 0, host: "127.0.0.1", origin: "http://localhost:8000", store: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { app.server.closeAllConnections?.(); app.server.close(resolve); }));
  return `http://127.0.0.1:${app.server.address().port}`;
}

test("/privacy.html is served as HTML, framing denied, for GET", async (t) => {
  const origin = await start(t);
  const response = await fetch(`${origin}/privacy.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
  const html = await response.text();
  assert.equal(html, await readFile(new URL("privacy.html", web), "utf8"), "served unchanged");
  assert.match(html, /<h1>Kin privacy policy<\/h1>/);
  // Its stylesheet and icon are served too.
  for (const path of ["/styles/app.css", "/icon.svg"]) assert.equal((await fetch(`${origin}${path}`)).status, 200, path);
});

test("the page needs nothing the CSP forbids: no scripts, no inline styles, only its own stylesheet", async () => {
  const html = await readFile(new URL("privacy.html", web), "utf8");
  const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csp, "the page sets its own policy, like index.html");
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
  const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sheets, ["/styles/app.css"]);
  const css = await readFile(new URL("styles/app.css", web), "utf8");
  for (const name of new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/))))
    assert.ok(css.includes(`.${name}`), `.${name} is styled in app.css`);
});

test("the page has the accessibility basics: language, title, one h1, ordered headings, a skip link, working anchors", async () => {
  const html = await readFile(new URL("privacy.html", web), "utf8");
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
  assert.doesNotMatch(html, /user-scalable|maximum-scale/, "zoom stays allowed");
  assert.match(html, /<title>Privacy policy · Kin<\/title>/);
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
  assert.equal(levels.filter((level) => level === 1).length, 1);
  assert.equal(levels[0], 1);
  for (let index = 1; index < levels.length; index++)
    assert.ok(levels[index] <= levels[index - 1] + 1, `heading levels don't skip (h${levels[index - 1]} → h${levels[index]})`);
  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /<main id="main"/);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `#${target} exists`);
  for (const [, label] of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(ids.has(label), `${label} labels its section`);
});

test("the policy states what Play's Data safety answers rely on", async () => {
  const html = await readFile(new URL("privacy.html", web), "utf8");
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const phrase of [
    "Effective 21 October 2026",
    "encrypted on your device before it leaves it",
    "Argon2id",
    "No advertising",
    "No selling, renting or sharing your information",
    "No analytics",
    "nothing you write is sent to an AI service",
    "IP address",
    "push address",
    "Leave household",
    "Delete household",
    "After 30 days",
    "Limited members",
    "HTTPS",
    "has not had an independent security review",
    "privacy@journeytocode.io",
  ]) assert.ok(text.includes(phrase), `the policy says "${phrase}"`);
  // docs/PLAY-LISTING.md and the Play Console point at these anchors.
  for (const id of ["delete", "children", "contact", "stores", "sees", "never"]) assert.match(html, new RegExp(`id="${id}"`));
});

test("the offline shell keeps the policy, and the app and README link to it", async () => {
  const worker = await readFile(new URL("service-worker.js", web), "utf8");
  assert.match(worker, /"\/privacy\.html"/);
  const views = await readFile(new URL("components/app/views.js", web), "utf8");
  assert.match(views, /href: "\/privacy\.html"/, "Household › Privacy & recovery links to it");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /web\/privacy\.html|\/privacy\.html/);
});
