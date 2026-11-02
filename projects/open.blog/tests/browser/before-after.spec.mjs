import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The real site: a `compare` fence renders the comparison control, falls back to two captioned
// pictures without JavaScript or with reduced motion, and is two plain figures in the feed (ADR 0291).

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
let root;
let server;
let origin;

const picture = (fill, word) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="${fill}"/><text x="400" y="320" font-size="96" text-anchor="middle" fill="#fff">${word}</text></svg>`;

const POST = `---
title: Floor refinishing
date: 2026-10-24
---
Two photos of the same floor.

\`\`\`compare
before: /images/floor-before.svg
before-alt: The old floor, stained and cracked along the door
before-caption: Day one
after: /images/floor-after.svg
after-alt: The same floor, sanded and sealed
after-label: Finished
\`\`\`

The end.
`;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-compare-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  mkdirSync(join(root, "static", "images"), { recursive: true });
  writeFileSync(join(root, "static", "images", "floor-before.svg"), picture("#6b5b4b", "Before"));
  writeFileSync(join(root, "static", "images", "floor-after.svg"), picture("#2f7d6d", "After"));
  writeFileSync(join(root, "content", "posts", "floor-refinishing.md"), POST);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/floor-refinishing/`)).ok).toBe(true);
  }).toPass({ timeout: 60000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  removeTree(root);
});

const url = () => `${origin}/floor-refinishing/`;
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const position = (page) =>
  page.locator("ob-compare").evaluate((element) => element.style.getPropertyValue("--ob-compare-pos"));

for (const [name, size] of [["desktop", { width: 1280, height: 800 }], ["phone at 400px", { width: 400, height: 800 }]]) {
  test(`the control works from the keyboard and by dragging on ${name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: size, hasTouch: size.width < 600 });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/api\/|Failed to load resource/.test(message.text())) problems.push(message.text());
    });
    await page.goto(url());
    await expect(page.locator("ob-compare[data-enhanced]")).toHaveCount(1);

    const range = page.getByRole("slider", { name: /Before and Finished|between Before and Finished/ });
    await expect(range).toHaveAttribute("aria-valuetext", "50% Before, 50% Finished");
    await expect(page.getByRole("group", { name: "Before and Finished comparison" })).toBeVisible();
    await expect(page.getByText("Before: Day one")).toBeVisible();
    await expect(page.locator(".ob-compare-pane figcaption", { hasText: "Finished" })).toBeVisible();

    await page.keyboard.press("Tab"); // reach the page's first stop, then the control
    await range.focus();
    await page.keyboard.press("ArrowRight");
    await expect(range).toHaveAttribute("aria-valuetext", "51% Before, 49% Finished");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(range).toHaveAttribute("aria-valuetext", "49% Before, 51% Finished");
    await page.keyboard.press("End");
    await expect(range).toHaveAttribute("aria-valuetext", "Before only");
    await page.keyboard.press("Home");
    await expect(range).toHaveAttribute("aria-valuetext", "Finished only");

    // Focus is visible on the knob, not only on a hidden input.
    const ring = await page.locator(".ob-compare-knob").evaluate((knob) => {
      const style = getComputedStyle(knob);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);

    const box = await page.locator(".ob-compare-stage").boundingBox();
    const first = await page.locator(".ob-compare-stage > img").boundingBox();
    expect(Math.abs(first.height - box.height)).toBeLessThan(1.5);
    expect(Math.abs(first.y - box.y)).toBeLessThan(1.5);
    expect(box.width).toBeGreaterThan(300 - 1);
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(range).toHaveAttribute("aria-valuetext", "80% Before, 20% Finished");
    expect(await position(page)).toBe("80%");

    // The knob is a real touch target.
    const knob = await page.locator(".ob-compare-knob").boundingBox();
    expect(Math.min(knob.width, knob.height)).toBeGreaterThanOrEqual(43);

    expect(await noOverflow(page)).toBeLessThanOrEqual(1);
    expect(problems).toEqual([]);
    await context.close();
  });
}

test("with reduced motion the two pictures stay side by side, and stacked on a phone", async ({ browser }) => {
  for (const [size, sideBySide] of [[{ width: 1280, height: 800 }, true], [{ width: 400, height: 800 }, false]]) {
    const context = await browser.newContext({ viewport: size, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(url());
    await expect(page.locator("ob-compare")).toHaveCount(1);
    await expect(page.locator("ob-compare[data-enhanced]")).toHaveCount(0);
    const images = page.locator("ob-compare img");
    await expect(images).toHaveCount(2);
    const [a, b] = [await images.nth(0).boundingBox(), await images.nth(1).boundingBox()];
    expect(a.width).toBeGreaterThan(100);
    if (sideBySide) expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    else expect(b.y).toBeGreaterThan(a.y + a.height - 1);
    expect(await noOverflow(page)).toBeLessThanOrEqual(1);
    await context.close();
  }
});

test("without JavaScript both captioned pictures are there", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(url());
  await expect(page.locator("ob-compare img")).toHaveCount(2);
  await expect(page.locator("ob-compare img").first()).toHaveAttribute("alt", "The old floor, stained and cracked along the door");
  await expect(page.locator("ob-compare figcaption")).toHaveText(["Before: Day one", "Finished"]);
  await expect(page.locator(".ob-compare-stage")).toHaveCount(0);
  await context.close();
});

test("the feeds carry two plain captioned figures and no component", async () => {
  const feed = await (await fetch(`${origin}/feed.json`)).json();
  const item = feed.items.find((entry) => entry.url.includes("floor-refinishing"));
  expect(item.content_html).toContain("<figcaption>Before: Day one</figcaption>");
  expect(item.content_html).toContain("<figcaption>Finished</figcaption>");
  expect(item.content_html.match(/<img /g)).toHaveLength(2);
  expect(item.content_html).toContain(`src="${origin}/images/floor-before.svg"`.replace(origin, "https://portable.example.org"));
  expect(item.content_html).not.toMatch(/ob-compare>|<span|<script/);
});
