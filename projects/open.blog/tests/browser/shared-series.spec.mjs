import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio page and sign-in, with the series API replaced by a small in-memory
// stand-in that checks the expected revision the way the server does. This exercises the series
// panel in a browser: create, assign, reorder, a denied save, a stale save, keyboard use and a
// phone-sized screen.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const PUBLICATION = "shared-0a1b2c3d4e5f";
let root;
let server;
let origin;
let api;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-series-"));
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

const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const slugOf = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const PARTS = [
  { title: "First letter", url: "/first-letter/", order: 1, thisPublication: false },
  { title: "Second letter", url: "/second-letter/", order: 2, thisPublication: false },
];

async function install(context, { roles = ["siteOwner", "contributor"], canCreate = true } = {}) {
  api = {
    revision: 0,
    placement: null,
    series: [{ slug: "letters-across-time", name: "Letters across time", parts: 2, defined: true }],
    denyNextSave: false,
    puts: [],
  };
  const preview = (series, order) => {
    if (!series) return null;
    const slug = slugOf(series);
    const known = api.series.find((item) => item.slug === slug);
    const parts = slug === "letters-across-time" ? PARTS.map((part) => ({ ...part })) : [];
    const at = order === null ? parts.length : parts.filter((part) => part.order <= order).length;
    parts.splice(at, 0, { order, thisPublication: true });
    return { slug, name: known?.name || series, defined: Boolean(known?.defined), description: known?.defined ? "Two writers answer one letter." : "", parts };
  };
  const view = (candidate) => ({
    revision: api.revision,
    placement: api.placement,
    canPlace: true,
    canCreate,
    published: false,
    series: api.series,
    preview: candidate ? preview(candidate.series, candidate.order) : api.placement ? preview(api.placement.series, api.placement.order ?? null) : null,
  });
  await context.route("**/admin/api/collaboration/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname.replace("/admin/api/collaboration/", "");
    if (path === "publications") {
      return json(route, 200, { publications: [{ publicationId: PUBLICATION, roles, title: "A shared reflection", guidingQuestion: "What stayed with you?", sources: [] }] });
    }
    if (path === "series" && method === "GET") {
      if (!url.searchParams.has("series")) return json(route, 200, view(null));
      const order = url.searchParams.get("order");
      return json(route, 200, view({ series: url.searchParams.get("series"), order: order === "" ? null : Number(order) }));
    }
    if (path === "series" && method === "PUT") {
      const body = request.postDataJSON();
      api.puts.push(body);
      if (api.denyNextSave) {
        api.denyNextSave = false;
        return json(route, 404, { error: "That shared reflection was not found, or you cannot see or arrange its series." });
      }
      if (body.expectedRevision !== api.revision) {
        return json(route, 409, { error: "The series placement changed while you were working. Reload to see the current choice; nothing was changed." });
      }
      if (JSON.stringify(body.placement) !== JSON.stringify(api.placement)) {
        api.placement = body.placement;
        api.revision += 1;
      }
      return json(route, 200, view(null));
    }
    if (path === "series/create" && method === "POST") {
      const body = request.postDataJSON();
      const slug = slugOf(body.title);
      api.series = [...api.series, { slug, name: body.title, parts: 0, defined: true }];
      return json(route, 201, { slug, name: body.title, path: `series/${slug}.md` });
    }
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
  await page.locator(".oba-series > summary").click();
  await expect(page.getByText("Not part of a series.")).toBeVisible();
}

const choice = (page) => page.getByLabel("Series", { exact: true });
const position = (page) => page.getByLabel("Position in the series (optional)");
const save = (page) => page.getByRole("button", { name: "Save placement" });

test("a site owner creates a series, assigns the reflection and reorders it with the keyboard alone", async ({ page, context }) => {
  await install(context);
  await openPanel(page);

  // Create: a new series with its recurring premise, which then becomes the chosen one.
  await page.locator(".oba-series-create > summary").focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Series name").focus();
  await page.keyboard.type("Seasons");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Each part answers one question.");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Series Seasons added/)).toBeVisible();
  await expect(choice(page)).toBeFocused();
  await expect(choice(page)).toHaveValue("seasons");
  expect(api.placement).toBeNull();

  // Assign: choose an existing series and a position, preview, then save.
  await choice(page).selectOption("letters-across-time");
  await position(page).focus();
  await page.keyboard.type("2");
  await page.getByRole("button", { name: "Preview order" }).press("Enter");
  const order = page.getByRole("list", { name: /Reading order/ });
  await expect(order).toContainText("2. Second letter (position 2)");
  await expect(order).toContainText("3. This shared reflection (not published yet, position 2)");
  expect(api.puts).toEqual([]);
  await save(page).press("Enter");
  await expect(page.getByText("Series: Letters across time, part 2")).toBeVisible();
  await expect(save(page)).toBeFocused();
  expect(api.placement).toEqual({ series: "letters-across-time", order: 2 });

  // Reorder: a new position against the revision just read.
  await position(page).fill("1");
  await save(page).press("Enter");
  await expect(page.getByText("Series: Letters across time, part 1")).toBeVisible();
  await expect(order).toContainText("2. This shared reflection (not published yet, position 1)");
  expect(api.puts.at(-1).expectedRevision).toBe(1);
});

test("a denied save and a stale save keep what was typed and say what happened", async ({ page, context }) => {
  await install(context, { roles: ["coordinator"], canCreate: false });
  await openPanel(page);
  await expect(page.locator(".oba-series-create")).toBeHidden();
  await choice(page).selectOption({ label: "A new series title..." });
  await page.getByLabel("New series title").fill("My typed title");
  await position(page).fill("4");

  api.denyNextSave = true;
  await save(page).click();
  await expect(page.getByRole("alert").filter({ hasText: /cannot arrange/ })).toBeFocused();
  await expect(page.getByLabel("New series title")).toHaveValue("My typed title");
  expect(api.placement).toBeNull();

  // Someone else saves first: the save is refused, the current choice appears, the typing stays.
  api.placement = { series: "letters-across-time", order: 3 };
  api.revision = 1;
  await save(page).click();
  await expect(page.getByRole("alert").filter({ hasText: /changed while you were working/ })).toBeFocused();
  await expect(page.getByText("Series: Letters across time, part 3")).toBeVisible();
  await expect(page.getByLabel("New series title")).toHaveValue("My typed title");
  await expect(position(page)).toHaveValue("4");
  await save(page).click();
  await expect(page.getByText(/Series: My typed title, part 4/)).toBeVisible();
  expect(api.placement).toEqual({ series: "My typed title", order: 4 });
});

test("on a phone-sized screen the series panel does not scroll sideways and stays usable", async ({ page, context }) => {
  await install(context);
  await page.setViewportSize({ width: 320, height: 700 });
  await openPanel(page);
  await choice(page).selectOption("letters-across-time");
  await page.getByRole("button", { name: "Preview order" }).click();
  await expect(page.getByRole("list", { name: /Reading order/ })).toContainText("This shared reflection");
  const wide = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll(".oba-series, .oba-series *")].filter((node) => node.getBoundingClientRect().right > limit + 1).map((node) => node.className || node.tagName);
  });
  expect(wide).toEqual([]);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll(".oba-series button")].filter((node) => node.offsetParent && node.getBoundingClientRect().height < 43.5).map((node) => node.textContent),
  );
  expect(small).toEqual([]);
});
