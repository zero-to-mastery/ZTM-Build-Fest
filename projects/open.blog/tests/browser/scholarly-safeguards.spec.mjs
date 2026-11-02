import { test, expect } from "@playwright/test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The scholarly-safeguard corpus in the real Admin Studio (#195, ADR 0151): for representative
// cases of the corpus, What will be public lists exactly the findings `openblog check --json`
// lists, in the same order, names only ids and places (never the private words of the case),
// writes nothing, and reflows at 320 pixels.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const corpus = JSON.parse(readFileSync(join(repository, "tests", "fixtures", "scholarly-safeguards", "corpus.json"), "utf8"));
const password = randomBytes(24).toString("hex");
const MODULES = ["social", "release", "field", "optimize", "accessibility", "evidence", "research", "assistant", "analytics", "contributors", "public-site"];
const CASES = ["versions-mixed", "claim-anchors", "chronology-relative", "comparison-withheld-rights", "context-link-unpublished", "similarity-is-not-influence"];
let root;
let server;
let origin;

const usePreset = () => {
  const file = join(root, ".openblog", "private", "admin-preferences", `${createHash("sha256").update("writer").digest("hex")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, preset: "simple", density: "comfortable", editorMode: "markdown", moduleOrder: MODULES, hiddenModules: [] }));
};
const cli = (...args) => {
  const run = spawnSync(binary, [...args, "--root", root], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout || "", stderr: run.stderr || "" };
};
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const privateBytes = () => {
  const dir = join(root, ".openblog", "private", "research");
  try { return walk(dir).filter((file) => !file.endsWith("acknowledgements.json")).map((file) => [file, readFileSync(file, "utf8")]); } catch { return []; }
};

/** Put one case's project in place over the clean one. */
function load(testCase) {
  rmSync(join(root, ".openblog", "private", "research"), { recursive: true, force: true });
  rmSync(join(root, "content", "posts", "lanterns.md"), { force: true });
  const files = { ...corpus.base.files, ...testCase.files };
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  const config = JSON.parse(readFileSync(join(root, "openblog.json"), "utf8"));
  for (const [key, value] of Object.entries({ ...corpus.base.config, ...testCase.config })) config[key] = value;
  writeFileSync(join(root, "openblog.json"), JSON.stringify(config, null, 2));
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-scholarly-safeguards-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  writeFileSync(join(root, "content", "posts", "portable-lesson.md"), "---\ntitle: A plain post\ndate: 2026-10-24\n---\n\nJust an article.\n");
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });
  load(corpus.cases.find((item) => item.id === CASES[0]));
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

async function signIn(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
}

for (const id of CASES) {
  test(`${id}: What will be public lists what the command line lists, and nothing private`, async ({ page }) => {
    const testCase = corpus.cases.find((item) => item.id === id);
    usePreset();
    load(testCase);
    const before = privateBytes();
    const json = cli("check", "--json");
    const report = JSON.parse(json.stdout);
    const expected = report.groups.flatMap((group) => group.findings.map((position) => report.findings[position].code));
    expect(new Set(report.findings.map((finding) => `${finding.validator}: ${finding.code}`))).toEqual(new Set(testCase.emits));

    await signIn(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${origin}/admin/#/research/public`);
    const region = page.locator('[data-publication-review="site"]');
    if (expected.length) {
      await expect(region.locator("[data-review-finding]").first()).toBeVisible();
    } else {
      await expect(region.locator("[data-review-empty]")).toBeVisible();
    }
    const shown = await region.locator("[data-review-finding]").evaluateAll((nodes) => nodes.map((node) => node.dataset.reviewFinding));
    expect(shown).toEqual(expected);
    // The words a case keeps private never appear in the page.
    const text = await page.locator("main, body").first().innerText();
    expect(text).not.toMatch(/Synthetic (claim|passage|question|rationale|doubt|reading)/);
    expect(text).not.toMatch(/influenc/i);
    // The region reflows at a phone's width.
    const overflow = await region.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // Reading changed no file.
    expect(privateBytes()).toEqual(before);
  });
}
