import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio page and sign-in, with the collaboration API replaced by a small in-memory
// stand-in that checks the expected revision the way the server does. This exercises the writer's
// draft panel in a browser: keyboard use, a phone viewport, going offline, two tabs, large text.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const PUBLICATION = "shared-0a1b2c3d4e5f";
const LIMIT = 100000;
let root;
let server;
let origin;
let store;
let offline;
let synthesis;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-drafts-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  execFileSync(binary, ["user", "add", "writer", "--root", root], {
    env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe",
  });
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--admin", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/admin/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  removeTree(root);
});

const stamp = (number) => ({ number, contributionId: "participant-1", digest: "d" });
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function install(context) {
  store = { number: 0, markdown: "" };
  synthesis = { revision: 0, items: [], authors: [{ id: "p-me", displayName: "Writer" }], you: "p-me" };
  offline = false;
  await context.route("**/admin/api/collaboration/**", async (route) => {
    const method = route.request().method();
    if (offline && method !== "GET") return route.abort("internetdisconnected");
    const path = new URL(route.request().url()).pathname.replace("/admin/api/collaboration/", "");
    if (path === "publications") {
      return json(route, 200, { publications: [{ publicationId: PUBLICATION, roles: ["contributor"], title: "A shared reflection", guidingQuestion: "What stayed with you?", sources: [] }] });
    }
    if (path === "draft" && method === "GET") return json(route, 200, { draft: store.number ? { stamp: stamp(store.number), markdown: store.markdown } : null });
    if (path === "draft" && method === "PUT") {
      const body = route.request().postDataJSON();
      if (body.markdown.length > LIMIT) return json(route, 413, { error: "That draft is too large." });
      if (body.expectedRevision !== store.number) {
        return json(route, 409, { error: "Your draft changed since you last read it.", current: { stamp: stamp(store.number), markdown: store.markdown } });
      }
      store = { number: store.number + 1, markdown: body.markdown };
      return json(route, 200, { stamp: stamp(store.number) });
    }
    if (path === "synthesis" && method === "GET") return json(route, 200, synthesis);
    if (path === "synthesis" && method === "POST") {
      const body = route.request().postDataJSON();
      if (body.expectedRevision !== synthesis.revision) return json(route, 409, { error: "The continuing conversation changed since you read it." });
      const me = synthesis.authors[0];
      const items = synthesis.items.map((item) => ({ ...item }));
      if (body.change.action === "add") {
        items.push({ id: `syn-${items.length + 1}`, kind: body.change.kind, markdown: body.change.markdown, revision: 1, contributors: [me], approved: [], awaiting: [me], mine: true, approvedByYou: false });
      } else if (body.change.action === "approve") {
        for (const item of items) if (item.id === body.change.id) Object.assign(item, { approved: [me], awaiting: [], approvedByYou: true });
      }
      synthesis = { ...synthesis, revision: synthesis.revision + 1, items };
      return json(route, 200, synthesis);
    }
    if (path === "reveal") return json(route, 200, { policy: "voluntary", ready: false, canSetPolicy: false, slots: [] });
    return json(route, 404, { error: "not found" });
  });
}

async function openPanel(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.goto(`${origin}/admin/#/shared`);
  await page.locator("summary", { hasText: "Your draft" }).click();
  await expect(editor(page)).toBeVisible();
}

const editor = (page) => page.getByLabel("Your reflection (Markdown)");
const saveDraft = (page) => page.getByRole("button", { name: "Save draft" });

test("the draft can be written and saved with the keyboard alone", async ({ page, context }) => {
  await install(context);
  await openPanel(page);
  await editor(page).focus();
  await page.keyboard.type("Typed without a mouse.");
  await saveDraft(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Saved as revision 1/).first()).toBeVisible();
  expect(store.markdown).toBe("Typed without a mouse.");
});

test("on a phone-sized screen the draft panel does not scroll sideways", async ({ page, context }) => {
  await install(context);
  await page.setViewportSize({ width: 320, height: 700 });
  await openPanel(page);
  const wide = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll(".oba-draft, .oba-draft *")].filter((node) => node.getBoundingClientRect().right > limit + 1).map((node) => node.className || node.tagName);
  });
  expect(wide).toEqual([]);
  await expect(editor(page)).toBeVisible();
});

test("going offline keeps the text and says so, and saving works again afterwards", async ({ page, context }) => {
  await install(context);
  await openPanel(page);
  await editor(page).fill("Written on a train.");
  offline = true;
  await saveDraft(page).click();
  await expect(page.getByRole("alert").first()).toContainText(/offline|could not reach/i);
  await expect(editor(page)).toHaveValue("Written on a train.");
  expect(store.number).toBe(0);
  offline = false;
  await saveDraft(page).click();
  await expect(page.getByText(/Saved as revision 1/).first()).toBeVisible();
});

test("a second tab saving first leads to a recovery choice and nothing is overwritten", async ({ page, context }) => {
  await install(context);
  await openPanel(page);
  const other = await context.newPage();
  await openPanel(other);
  await editor(other).fill("From the other tab.");
  await saveDraft(other).click();
  await expect(other.getByText(/Saved as revision 1/).first()).toBeVisible();
  await editor(page).fill("From the first tab.");
  await saveDraft(page).click();
  await expect(page.getByRole("heading", { name: "Your draft changed elsewhere" })).toBeFocused();
  expect(store.markdown).toBe("From the other tab.");
  await expect(editor(page)).toHaveValue("From the first tab.");
  await page.getByRole("button", { name: "Save my text as a new revision" }).click();
  await expect(page.getByText(/Saved as revision 2/).first()).toBeVisible();
  expect(store.markdown).toBe("From the first tab.");
});

test("a large draft saves, and one that is too large is refused without losing the text", async ({ page, context }) => {
  await install(context);
  await openPanel(page);
  const large = "word ".repeat(15000);
  await editor(page).fill(large);
  await saveDraft(page).click();
  await expect(page.getByText(/Saved as revision 1/).first()).toBeVisible();
  expect(store.markdown.length).toBe(large.length);
  const tooLarge = "word ".repeat(30000);
  await editor(page).fill(tooLarge);
  await saveDraft(page).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(editor(page)).toHaveValue(tooLarge);
  expect(store.number).toBe(1);
});

// The combined preview: two authors in mixed states. The document is the stand-in's, carrying the
// real policy and frame headers from the server code, so this checks what the browser does with
// them: the empty-sandbox frame loads, nothing in it runs or fetches, and the page is labelled.
const previewPolicy = readFileSync(join(repository, "crates", "openblog-core", "src", "preview.rs"), "utf8")
  .match(/PREVIEW_CSP: &str = "([\s\S]*?)";/)[1]
  .replace(/\\\s+/g, "");
const TRACKER = "https://tracker.invalid/pixel.gif";
const previewDocument = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview, not published: A shared reflection</title></head><body>
<p role="note"><strong>Preview, not published.</strong> Only authors of this piece can see it.</p>
<p role="status">Incomplete: some sections are not shared with you at their current revision.</p>
<h1>A shared reflection</h1>
<section><p>Writer (you): revision 1.</p><div><p>Writer's own words.</p><script>document.body.insertAdjacentHTML("beforeend", '<i id="ran"></i>')</script><img src="${TRACKER}" alt=""><a href="javascript:document.title='clicked'">link</a></div></section>
<section><p>Bo: not shared with you at its current revision.</p></section>
</body></html>`;

test("the combined preview loads in an empty sandbox, runs and fetches nothing, and is labelled", async ({ page, context }) => {
  await install(context);
  const trackerRequests = [];
  // Count only requests that reach the network: Chromium still reports CSP-blocked ones as request events.
  await context.route("https://tracker.invalid/**", (route) => { trackerRequests.push(route.request().url()); return route.abort(); });
  await context.route("**/admin/api/collaboration/reveal?**", (route) => json(route, 200, {
    policy: "voluntary", ready: false, canSetPolicy: false,
    slots: [
      { participantId: "p1", displayName: "Writer", kind: "own", ready: false, stamp: stamp(1), markdown: "Writer's own words." },
      { participantId: "p2", displayName: "Bo", kind: "private", ready: false, stamp: null, markdown: null },
    ],
  }));
  await context.route("**/admin/api/collaboration/preview?**", (route) => json(route, 200, {
    preview: {
      complete: false, ready: false, seen: null, previewUrl: "/admin/api/preview/" + "a".repeat(64),
      sections: [
        { participantId: "p1", displayName: "Writer", shown: true, revision: 1, approval: "awaiting", required: true, errors: [] },
        { participantId: "p2", displayName: "Bo", shown: false, revision: null, approval: "awaiting", required: true, errors: [] },
      ],
    },
  }));
  let framed = 0;
  await context.route("**/admin/api/preview/**", (route) => {
    framed += 1;
    return route.fulfill({
      status: 200, contentType: "text/html; charset=utf-8", body: previewDocument,
      headers: { "Content-Security-Policy": previewPolicy, "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "no-referrer" },
    });
  });
  await openPanel(page);
  await page.getByRole("button", { name: "Review the combined piece" }).click();

  const frame = page.locator('iframe[title="Combined piece preview, not published"]');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("src", /^\/admin\/api\/preview\/[0-9a-f]{64}$/);
  const inside = page.frameLocator('iframe[title="Combined piece preview, not published"]');
  await expect(inside.getByRole("note")).toContainText("Preview, not published.");
  await expect(inside.getByRole("status")).toContainText("Incomplete");
  await expect(inside.getByText("Writer's own words.")).toBeVisible();
  await expect(inside.getByText("Bo: not shared with you at its current revision.")).toBeVisible();
  expect(framed).toBeGreaterThan(0);

  // Nothing ran in the frame and nothing was fetched from it.
  await expect(inside.locator("#ran")).toHaveCount(0);
  await expect(inside.locator("#ran")).toHaveCount(0);
  expect(trackerRequests).toEqual([]);

  // The Admin page announces the same state and lists each author, without any prose from Bo.
  await expect(page.getByRole("status").filter({ hasText: "Preview, not published." })).toContainText("Incomplete");
  await expect(page.getByRole("list", { name: "Authors in the combined piece" })).toContainText("Bo: not shared with you at its current revision");
  await expect(page.getByRole("list", { name: "Authors in the combined piece" })).not.toContainText("private words");
});

test("the continuing conversation works with the keyboard alone at phone width, and focus is never lost", async ({ page, context }) => {
  await install(context);
  await page.setViewportSize({ width: 320, height: 700 });
  await openPanel(page);
  const heading = page.getByRole("heading", { name: "Continuing conversation" });
  await expect(heading).toBeVisible();
  const text = page.locator(".oba-synthesis-form textarea");
  await text.focus();
  await page.keyboard.type("We both noticed the pause.");
  await page.getByRole("button", { name: "Add item" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Item 1 of 1\. Agreement, speaking for Writer/)).toBeVisible();
  await expect(heading).toBeFocused();
  expect(synthesis.items[0].markdown).toBe("We both noticed the pause.");
  await page.getByRole("button", { name: "Approve this item" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "You approved this" })).toBeDisabled();
  await expect(page.locator(".oba-synthesis-item").getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  await page.locator(".oba-synthesis-item").getByRole("button", { name: "Edit", exact: true }).press("Enter");
  await expect(page.getByLabel("Edit item text")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Edit cancelled. Nothing was changed.")).toBeVisible();
  await expect(page.locator(".oba-synthesis-item").getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  const wide = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll(".oba-synthesis, .oba-synthesis *")].filter((node) => node.getBoundingClientRect().right > limit + 1).map((node) => node.className || node.tagName);
  });
  expect(wide).toEqual([]);
});
