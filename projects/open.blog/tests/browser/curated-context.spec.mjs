import { test, expect, request as playwrightRequest } from "@playwright/test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The curated research-context projection on a post's page (#197, ADR 0197): built from selections an
// author made through the real Admin API, then served by the real binary. The section is static, complete
// without JavaScript, reads in order, has a canonical anchor for each item, reflows at 320 pixels and at
// 400% zoom, prints whole, treats authored text as text, and the data file Reader Discovery reads holds
// only the selected revision and no private sentinel.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const LEAK = (label) => `ZqxLeak ${label} sentinel words kept private`;
const UNSAFE = "http://files.internal/ZqxLeakUrlSegmentSentinelAbcdefghijkl";
const LONG = "W".repeat(300);
const HOSTILE = `</script><img src=x onerror="window.__xss=1"> <b>bold</b> & javascript:alert(1) ${LONG}`;
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato", kind: "work", title: "Politeia" },
    {
      id: "slings", kind: "edition", of: "plato", title: "Platonis Rempublicam",
      notes: LEAK("librarynote"),
      identifiers: [{ scheme: "url", value: UNSAFE }, { scheme: "doi", value: "10.1000/slings" }, { scheme: "shelfmark", value: LEAK("shelfmark") }],
    },
    { id: "diary", kind: "work", title: LEAK("privatesource") },
  ],
};
const NOTEBOOK = { version: 1, passages: [], notes: [{ id: "worry", kind: "question", text: LEAK("note") }] };
const dating = (id, year) => ({ id, aspect: "birth", date: { at: { year } }, assertedBy: { kind: "author" }, evidence: [{ source: "slings" }], visibility: "approved" });
const ATLAS = {
  version: 2,
  entries: [
    { id: "plato-person", kind: "person", label: "Plato", summary: "An Athenian philosopher.", visibility: "approved", dates: [dating("born-a", -428), dating("born-b", -424)] },
    { id: "politeia", kind: "work", label: "Politeia", source: "plato", visibility: "approved" },
    { id: "the-good", kind: "concept", label: LEAK("entrylabel"), summary: LEAK("entrysummary") },
  ],
  relationships: [
    { id: "plato-authored-politeia", kind: "authored", from: "plato-person", to: "politeia", assertedBy: { kind: "author" }, evidence: [{ source: "slings" }], uncertainty: "The dating is unsettled.", visibility: "approved" },
  ],
};
const POST = (title, body) => `---\ntitle: ${title}\ndate: 2026-10-01\n---\n\n${body}\n`;
let root;
let origin;
let server;
let items = [];

const research = (name) => join(root, ".openblog", "private", "research", name);
const freePort = async () => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
};
const start = async (args, port, path) => {
  const child = spawn(binary, args, { cwd: repository, stdio: "pipe" });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    const reply = await fetch(`http://127.0.0.1:${port}${path}`);
    if (!reply.ok) throw new Error(`${path} answered ${reply.status}: ${output}`);
  }).toPass({ timeout: 30000 });
  return child;
};
const stop = async (child) => {
  if (child && child.exitCode === null) {
    const stopped = once(child, "exit");
    child.kill();
    await stopped;
  }
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-curated-context-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("atlas.json"), JSON.stringify(ATLAS));
  writeFileSync(join(root, "content", "posts", "cave.md"), POST("Cave", "The cave educates."));
  writeFileSync(join(root, "content", "posts", "other.md"), POST("Other", "Another post, offered only what is for the whole site."));
  const config = JSON.parse(readFileSync(join(root, "openblog.json"), "utf8"));
  config.knowledgeAtlas = { publish: true };
  config.curatedContext = { publish: true };
  writeFileSync(join(root, "openblog.json"), JSON.stringify(config, null, 2));
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });

  // The author selects through the real Admin API, as the writing workspace does.
  const adminPort = await freePort();
  const admin = await start(["serve", "--admin", "--root", root, "--port", String(adminPort)], adminPort, "/admin/");
  try {
    const api = await playwrightRequest.newContext({ baseURL: `http://127.0.0.1:${adminPort}` });
    const login = await api.post("/admin/api/login", { data: { username: "writer", password } });
    expect(login.status()).toBe(200);
    const csrf = (await (await api.get("/admin/api/session")).json()).csrf;
    const headers = { "X-CSRF-Token": csrf, "Content-Type": "application/json" };
    let revision = (await (await api.get("/admin/api/research/curation?post=cave")).json()).revision;
    const select = async (selection) => {
      const response = await api.post("/admin/api/research/curation/selections", { headers, data: { revision, post: "cave", selection } });
      expect(response.status(), await response.text()).toBe(201);
      const body = await response.json();
      revision = body.revision;
      return body.changed;
    };
    const ids = [];
    ids.push(await select({ kind: "contextual-entry", target: "plato-person", optionalFields: ["summary"], posts: ["cave"] }));
    ids.push(await select({ kind: "relationship", target: "plato-authored-politeia", posts: ["cave"] }));
    ids.push(await select({ kind: "timeline", target: "born-a" }));
    ids.push(await select({ kind: "reference", target: "slings", optionalFields: ["identifiers"], posts: ["cave"], provenance: { origin: "imported", from: "a library catalogue" } }));
    ids.push(await select({ kind: "source-annotation", target: "slings", text: HOSTILE, by: "The <i>author</i>", posts: ["cave"] }));
    const withdrawn = await select({ kind: "source-annotation", target: "plato", text: LEAK("withdrawncomment"), by: "The author", posts: ["cave"] });
    const gone = await api.put("/admin/api/research/curation/selections", { headers, data: { revision, post: "cave", action: "withdraw", id: withdrawn } });
    expect(gone.status()).toBe(200);
    revision = (await gone.json()).revision;
    // The author orders them: the comment first, the entry last.
    const order = [ids[4], ids[1], ids[2], ids[3], ids[0]];
    const ordered = await api.put("/admin/api/research/curation/order", { headers, data: { revision, post: "cave", order } });
    expect(ordered.status(), await ordered.text()).toBe(200);
    items = order;
    await api.dispose();
  } finally {
    await stop(admin);
  }
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = await start(["serve", "--root", root, "--port", String(port)], port, "/cave/");
});

test.afterAll(async () => {
  await stop(server);
  removeTree(root);
});

const section = (page) => page.locator("section#ob-research-context");
const fileJson = async () => (await fetch(`${origin}/curated-context.json`)).json();

/** Elements of `region` whose box ends right of it, or a page that scrolls sideways. */
const overflowing = (region) =>
  region.evaluate((element) => {
    const edge = element.getBoundingClientRect().right;
    return [...element.querySelectorAll("*")]
      .filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > edge + 1)
      .map((node) => `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`)
      .concat(element.getBoundingClientRect().right > window.innerWidth + 1 ? ["the region is wider than the window"] : [])
      .concat(document.documentElement.scrollWidth - window.innerWidth > 1 ? ["the page scrolls sideways"] : []);
  });

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the section is complete: each item in the author's order with attribution, doubt and evidence as text", async ({ page }) => {
    await page.goto(`${origin}/cave/`);
    const region = page.getByRole("region", { name: "Research context" });
    await expect(region).toBeVisible();
    await expect(section(page).getByRole("heading", { level: 2, name: "Research context" })).toBeVisible();
    // Items sit in the order the author gave, and a withdrawn one is not there.
    const ids = await section(page).locator("li.ob-curated-item").evaluateAll((nodes) => nodes.map((node) => node.dataset.curatedId));
    expect(ids).toEqual(items);
    // Screen-reader order: the section heading, then one heading per item, then what they refer to.
    const headings = await section(page).locator("h2, h3").evaluateAll((nodes) => nodes.map((node) => `${node.tagName} ${node.textContent.trim()}`));
    expect(headings[0]).toBe("H2 Research context");
    expect(headings.length).toBe(items.length + 2);
    expect(headings.at(-1)).toBe("H3 What these refer to");
    expect(headings[1]).toMatch(/^H3 The author's comment on a source: Platonis Rempublicam$/);
    const relationship = section(page).locator('li[data-curated-kind="relationship"]');
    await expect(relationship).toContainText("Relationship: Plato authored Politeia");
    for (const words of ["Who asserts it", "the site author", "How firmly", "What is doubtful", "The dating is unsettled.", "The evidence", "Platonis Rempublicam"]) {
      await expect(relationship).toContainText(words);
    }
    const reference = section(page).locator('li[data-curated-kind="reference"]');
    await expect(reference).toContainText("Where this metadata came from: imported from a library catalogue.");
    await expect(reference).toContainText("doi: 10.1000/slings");
    // The entry is a real link to its atlas page, which works without JavaScript.
    await section(page).getByRole("link", { name: "Atlas entry: Plato" }).click();
    await expect(page).toHaveURL(`${origin}/atlas/plato-person/`);
    // The data file is linked from the section and fetches.
    await page.goto(`${origin}/cave/`);
    await section(page).getByRole("link", { name: "The same context as data" }).click();
    await expect(page).toHaveURL(`${origin}/curated-context.json`);
  });
});

test("every item has a canonical anchor that lands on it, and the data file names the same addresses", async ({ page }) => {
  const file = await fileJson();
  const cave = file.posts.find((post) => post.post === "cave");
  expect(cave.items.map((item) => item.id)).toEqual(items);
  for (const item of cave.items) {
    // A fresh document each time, so a smooth scroll to the last anchor never carries into this one.
    await page.goto("about:blank");
    await page.goto(`${origin}${item.url}`);
    const target = await page.evaluate(() => document.querySelector(":target")?.id || "");
    expect(target).toBe(`ob-curated-${item.id}`);
    const box = await page.locator(`#ob-curated-${item.id}`).boundingBox();
    expect(box).not.toBeNull();
    await expect(page.locator(`#ob-curated-${item.id}`)).toBeInViewport();
  }
  // The page of a post that has only the whole-site item says so, and a fragment from one post is not on another's.
  await page.goto(`${origin}/other/`);
  await expect(section(page).locator("li.ob-curated-item")).toHaveCount(1);
  await expect(section(page).locator('li[data-curated-kind="timeline"]')).toHaveCount(1);
});

test("the data file is versioned, deterministic, holds only the selected revision and no private sentinel", async () => {
  const response = await fetch(`${origin}/curated-context.json`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("json");
  const text = await response.text();
  expect(text).toBe(await (await fetch(`${origin}/curated-context.json`)).text());
  const file = JSON.parse(text);
  expect(file.format).toBe("openblog-curated-context-file");
  expect(file.formatVersion).toBe(1);
  expect(file.items.length).toBe(5);
  // Each item carries the revision that was selected, which is the stored one.
  const stored = JSON.parse(readFileSync(research("selections.json"), "utf8")).selections;
  for (const item of file.items) {
    expect(item.revision).toBe(stored.find((selection) => selection.id === item.id).revision);
  }
  // Nothing it holds can be queried for more: the only addresses are public pages.
  for (const label of ["librarynote", "shelfmark", "privatesource", "note", "entrylabel", "entrysummary", "withdrawncomment"]) {
    expect(text, label).not.toContain(LEAK(label));
  }
  expect(text).not.toContain("files.internal");
  expect(text).not.toContain(".openblog");
  expect(text).not.toContain("selections.json");
  expect(text).not.toMatch(/[<>&]/);
  // The author's own comment is data, kept as written.
  expect(file.items.find((item) => item.kind === "source-annotation").content.text).toBe(HOSTILE);
});

test("authored text is text: nothing in it is markup, runs, or links anywhere", async ({ page }) => {
  await page.goto(`${origin}/cave/`);
  await expect(section(page).locator("img")).toHaveCount(0);
  await expect(section(page).locator("b")).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  const comment = section(page).locator('li[data-curated-kind="source-annotation"]');
  await expect(comment).toContainText("<img src=x onerror=\"window.__xss=1\"> <b>bold</b> & javascript:alert(1)");
  await expect(comment).toContainText("The <i>author</i>");
  const hrefs = await section(page).locator("a").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
  for (const href of hrefs) expect(href).toMatch(/^(\/(?!\/)|#)/);
});

for (const [name, setup] of [
  ["320 pixels", async (page) => page.setViewportSize({ width: 320, height: 720 })],
  // A browser at 400% zoom lays the page out at a quarter of its window's width, at four device pixels per CSS pixel.
  ["400% zoom of a 1280 pixel window", async (page) => {
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 225, deviceScaleFactor: 4, mobile: false });
  }],
]) {
  test(`the section reflows at ${name} without sideways scrolling, even with an unbroken 300 character word`, async ({ page }) => {
    await setup(page);
    await page.goto(`${origin}/cave/`);
    await setup(page);
    await expect(section(page)).toBeVisible();
    expect(await overflowing(section(page))).toEqual([]);
    await section(page).locator("li.ob-curated-item").last().scrollIntoViewIfNeeded();
    expect(await overflowing(section(page))).toEqual([]);
  });
}

test("print keeps every item whole, in order, and visible", async ({ page }) => {
  await page.emulateMedia({ media: "print" });
  await page.goto(`${origin}/cave/`);
  await expect(section(page).locator("li.ob-curated-item")).toHaveCount(items.length);
  for (const node of await section(page).locator("li.ob-curated-item").all()) await expect(node).toBeVisible();
  const breaks = await section(page).locator("li.ob-curated-item").first().evaluate((node) => getComputedStyle(node).breakInside);
  expect(breaks).toBe("avoid");
  expect(await overflowing(section(page))).toEqual([]);
  // The section's own notice is not hidden on paper.
  await expect(section(page).locator(".ob-curated-note")).toBeVisible();
});

test("a build of the same site writes the same bytes and no private sentinel anywhere", async () => {
  const first = join(root, "dist-first");
  const second = join(root, "dist-second");
  for (const out of [first, second]) {
    const built = spawnSync(binary, ["build", "--root", root, "--out", out], { encoding: "utf8" });
    expect(built.status, `${built.stdout}${built.stderr}`).toBe(0);
  }
  const walk = (dir, base = dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path, base) : [path.slice(base.length + 1).replace(/\\/g, "/")];
    });
  const files = walk(first);
  expect(files).toContain("curated-context.json");
  expect(walk(second)).toEqual(files);
  for (const file of files) {
    const bytes = readFileSync(join(first, file));
    expect(bytes.equals(readFileSync(join(second, file))), file).toBe(true);
    if (/\.(html|json|xml|txt|css|js|mjs|svg)$/.test(file)) {
      const text = bytes.toString("utf8");
      for (const label of ["librarynote", "shelfmark", "privatesource", "note", "entrylabel", "entrysummary", "withdrawncomment"]) expect(text, `${label} in ${file}`).not.toContain(LEAK(label));
      expect(text, file).not.toContain("files.internal");
    }
  }
  // The comment reaches the data file and the one page it is for, and no other file.
  const carrying = files.filter((file) => readFileSync(join(first, file), "utf8").includes("window.__xss"));
  expect(carrying.every((file) => ["curated-context.json", "feed.json", "rss.xml", "llms-full.txt"].includes(file) || file.startsWith("cave/"))).toBe(true);
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
});

test("the feed's and the portable copies' links back land on the real section and items of the canonical page", async ({ page }) => {
  const feed = await (await fetch(`${origin}/feed.json`)).json();
  const cave = feed.items.find((item) => new URL(item.url).pathname === "/cave/");
  expect(cave, "the post is in the feed").toBeTruthy();
  const context = cave._openblog.researchContext;
  expect(context.items.map((item) => item.id)).toEqual(items);
  // The full-content copy carries each selected fact and links to every item's anchor.
  for (const item of context.items) {
    expect(cave.content_html).toContain(item.url);
    expect(cave.content_text).toContain(item.url);
  }
  expect(cave.content_html).toContain(context.url);
  expect(cave.content_html).not.toMatch(/<script|\sid=|data-curated/);
  // llms-full.txt carries it too, under the same heading, and none of the private words.
  const full = await (await fetch(`${origin}/llms-full.txt`)).text();
  expect(full).toContain("## Research context");
  expect(full).not.toContain(LEAK("withdrawncomment"));
  // Each link back resolves, on the site as served, to the element it names.
  for (const url of [context.url, ...context.items.map((item) => item.url)]) {
    const hash = new URL(url).hash;
    await page.goto(`${origin}/cave/${hash}`);
    await expect(page.locator(hash)).toBeVisible();
  }
});
