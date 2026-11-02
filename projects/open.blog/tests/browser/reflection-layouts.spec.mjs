import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Sequential and side-by-side presentation of one approved reflection (ADR 0031). The markup is
// what the publish gate writes (crates/openblog-core/src/reflection.rs, `compose`); the styles are
// the real public stylesheet. The DOM order is the reading order and CSS only places it.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const styles = readFileSync(join(repository, "web", "base.css"), "utf8");

const LONG = "A long section that runs on and on so the other lane stays short. ".repeat(40);
const UNBROKEN = "x".repeat(200);

const turn = (lane, name, body) =>
  `<section class="ob-turn ob-lane-${lane}">\n<h2 class="ob-turn-author">${name}</h2>\n\n<p>${body}</p>\n\n</section>\n`;

function page({ layout, lanes, css = true }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${css ? `<style>${styles}</style>` : ""}</head><body><main><article>
<div class="ob-reflection ob-reflection-${layout} ob-lanes-${lanes}">
<div class="ob-round">
<p class="ob-round-prompt">What stood out?</p>
${turn(0, "Ann", `ANN-ONE ${LONG}`)}${turn(lanes > 1 ? 1 : 0, "Bo", "BO-ONE short")}${turn(0, "Ann", "ANN-TWO")}${turn(lanes > 1 ? 1 : 0, "Bo", `BO-TWO ${UNBROKEN}`)}
</div>
</div>
</article></main></body></html>`;
}

const boxes = (target) =>
  target.evaluate(() =>
    [...document.querySelectorAll(".ob-turn")].map((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height, text: node.querySelector("h2").textContent + ":" + node.textContent.slice(0, 20) };
    }),
  );

test("side by side puts lanes in columns on a wide screen and keeps the reading order in the DOM", async ({ page: tab }) => {
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.setContent(page({ layout: "side-by-side", lanes: 2 }));
  const [a1, b1, a2, b2] = await boxes(tab);
  expect(b1.x).toBeGreaterThan(a1.x + a1.width - 1);
  expect(Math.abs(b1.y - a1.y)).toBeLessThan(2);
  // Unequal lengths: the next row starts below the longer section, never overlapping it.
  expect(a2.y).toBeGreaterThanOrEqual(a1.y + a1.height - 1);
  expect(b2.y).toBeGreaterThanOrEqual(a2.y - 1);
  const order = await tab.evaluate(() => [...document.querySelectorAll(".ob-turn")].map((n) => n.textContent.match(/(ANN|BO)-(ONE|TWO)/)[0]));
  expect(order).toEqual(["ANN-ONE", "BO-ONE", "ANN-TWO", "BO-TWO"]);
});

test("it collapses to one column at a narrow width or 400% zoom, without sideways scrolling", async ({ page: tab }) => {
  await tab.setViewportSize({ width: 320, height: 800 });
  await tab.setContent(page({ layout: "side-by-side", lanes: 2 }));
  const list = await boxes(tab);
  for (const [index, box] of list.entries()) {
    expect(Math.abs(box.x - list[0].x)).toBeLessThan(2);
    if (index > 0) expect(box.y).toBeGreaterThanOrEqual(list[index - 1].y + list[index - 1].height - 1);
  }
  const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("print and a wide screen with more lanes than the styles lay out both read top to bottom", async ({ page: tab }) => {
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.setContent(page({ layout: "side-by-side", lanes: 2 }));
  await tab.emulateMedia({ media: "print" });
  const printed = await boxes(tab);
  for (const [index, box] of printed.entries()) {
    expect(Math.abs(box.x - printed[0].x)).toBeLessThan(2);
    if (index > 0) expect(box.y).toBeGreaterThanOrEqual(printed[index - 1].y + printed[index - 1].height - 1);
  }
  await tab.emulateMedia({ media: "screen" });
  await tab.setContent(page({ layout: "side-by-side", lanes: 4 }));
  const many = await boxes(tab);
  expect(new Set(many.map((box) => Math.round(box.x))).size).toBe(1);
});

test("without styles or scripts every turn keeps its own heading, in reading order", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const tab = await context.newPage();
  await tab.setContent(page({ layout: "side-by-side", lanes: 2, css: false }));
  const names = await tab.locator("h2.ob-turn-author").allTextContents();
  expect(names).toEqual(["Ann", "Bo", "Ann", "Bo"]);
  const text = await tab.locator("article").innerText();
  expect(text.indexOf("What stood out?")).toBeLessThan(text.indexOf("ANN-ONE"));
  expect(text.indexOf("ANN-ONE")).toBeLessThan(text.indexOf("BO-ONE"));
  expect(text.indexOf("BO-ONE")).toBeLessThan(text.indexOf("ANN-TWO"));
  expect(text.indexOf("ANN-TWO")).toBeLessThan(text.indexOf("BO-TWO"));
  await context.close();
});

test("the sequential layout is one column at every width and keyboard focus follows the DOM", async ({ page: tab }) => {
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.setContent(page({ layout: "sequential", lanes: 1 }).replace("<p>ANN-TWO</p>", '<p><a href="#a">ANN-TWO link</a> <a href="#b">second link</a></p>'));
  const list = await boxes(tab);
  for (const box of list) expect(Math.abs(box.x - list[0].x)).toBeLessThan(2);
  await tab.keyboard.press("Tab");
  await expect(tab.locator("a").first()).toBeFocused();
  await tab.keyboard.press("Tab");
  await expect(tab.locator("a").nth(1)).toBeFocused();
});

// ---------------------------------------------------------------- point-counterpoint, dialogue,
// roundtable (ADR 0032). The same markup rules: the DOM order is the reading order, the h2 names
// the author, and CSS only places it.

function arrangedPage({ layout, turns, css = true, dir = "ltr" }) {
  const lanes = Math.max(...turns.map((t) => t.lane)) + 1;
  const sections = turns
    .map(
      (t) =>
        `<section class="ob-turn ob-lane-${t.lane}">\n<h2 class="ob-turn-author">${t.name}</h2>\n${t.label ? `<p class="ob-turn-label">${t.label}</p>\n` : ""}\n<p>${t.body}</p>\n\n</section>\n`,
    )
    .join("");
  return `<!doctype html><html lang="en" dir="${dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${css ? `<style>${styles}</style>` : ""}</head><body><main><article>
<div class="ob-reflection ob-reflection-${layout} ob-lanes-${Math.min(lanes, 4)}">
<div class="ob-round">
<p class="ob-round-prompt">What stood out?</p>
${sections}</div>
</div>
</article></main></body></html>`;
}

const duet = [
  { lane: 0, name: "Ann", body: `ANN-ONE ${LONG}`, label: "Point" },
  { lane: 1, name: "Bo", body: "BO-ONE short", label: "Counterpoint" },
  { lane: 0, name: "Ann", body: "ANN-TWO" },
  { lane: 1, name: "Bo", body: `BO-TWO ${UNBROKEN}` },
  { lane: 0, name: "Ann", body: "ANN-THREE odd turn out" },
];

const readingOrder = (tab) => tab.evaluate(() => [...document.querySelectorAll(".ob-turn")].map((n) => n.textContent.match(/[A-Z]+-[A-Z0-9]+/)[0]));

const oneColumn = (list) => {
  for (const [index, box] of list.entries()) {
    expect(Math.abs(box.x - list[0].x)).toBeLessThan(2);
    if (index > 0) expect(box.y).toBeGreaterThanOrEqual(list[index - 1].y + list[index - 1].height - 1);
  }
};

test("point and counterpoint sit in two columns by first appearance, with an odd turn and optional labels", async ({ page: tab }) => {
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.setContent(arrangedPage({ layout: "point-counterpoint", turns: duet }));
  const [a1, b1, a2, b2, a3] = await boxes(tab);
  expect(b1.x).toBeGreaterThan(a1.x + a1.width - 1);
  expect(Math.abs(b1.y - a1.y)).toBeLessThan(2);
  expect(a2.y).toBeGreaterThanOrEqual(a1.y + a1.height - 1);
  // The odd last turn sits alone in the first lane below the pair before it.
  expect(a3.y).toBeGreaterThanOrEqual(b2.y + b2.height - 1);
  expect(Math.abs(a3.x - a1.x)).toBeLessThan(2);
  expect(await readingOrder(tab)).toEqual(["ANN-ONE", "BO-ONE", "ANN-TWO", "BO-TWO", "ANN-THREE"]);
  await expect(tab.locator(".ob-turn-label")).toHaveText(["Point", "Counterpoint"]);
  const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("point and counterpoint, dialogue and roundtable read as one column when narrow, zoomed or printed", async ({ page: tab }) => {
  const many = Array.from({ length: 7 }, (_, i) => ({ lane: i, name: `Person ${i}`, body: `TABLE-${i}` }));
  const cases = [
    ["point-counterpoint", duet],
    ["alternating-dialogue", duet],
    ["roundtable", many],
  ];
  for (const [layout, turns] of cases) {
    await tab.setViewportSize({ width: 320, height: 800 });
    await tab.emulateMedia({ media: "screen" });
    await tab.setContent(arrangedPage({ layout, turns }));
    oneColumn(await boxes(tab));
    expect(await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await tab.setViewportSize({ width: 1280, height: 900 });
    await tab.emulateMedia({ media: "print" });
    oneColumn(await boxes(tab));
  }
});

test("alternating dialogue staggers turns on a wide screen without reordering them", async ({ page: tab }) => {
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.setContent(arrangedPage({ layout: "alternating-dialogue", turns: duet }));
  const list = await boxes(tab);
  // One turn per row, in reading order; every second turn sits toward the other edge.
  for (const [index, box] of list.entries()) {
    if (index > 0) expect(box.y).toBeGreaterThanOrEqual(list[index - 1].y + list[index - 1].height - 1);
  }
  expect(list[1].x).toBeGreaterThan(list[0].x + 50);
  expect(Math.abs(list[2].x - list[0].x)).toBeLessThan(2);
  expect(list[0].width).toBeLessThan(1280 * 0.85);
  expect(await readingOrder(tab)).toEqual(["ANN-ONE", "BO-ONE", "ANN-TWO", "BO-TWO", "ANN-THREE"]);
});

test("a roundtable fits any number of participants and its visual rows follow the reading order", async ({ page: tab }) => {
  await tab.setViewportSize({ width: 1280, height: 900 });
  for (const count of [1, 2, 3, 7, 12]) {
    const turns = Array.from({ length: count }, (_, i) => ({ lane: i, name: `Person ${i}`, body: `TABLE-${i}` }));
    await tab.setContent(arrangedPage({ layout: "roundtable", turns }));
    const list = await boxes(tab);
    expect(list).toHaveLength(count);
    if (count > 1) expect(new Set(list.map((box) => Math.round(box.y))).size).toBeLessThan(count);
    // Sorted by row then column is exactly the DOM order, so nothing is visually rearranged.
    const visual = list
      .map((box, index) => ({ ...box, index }))
      .sort((a, b) => Math.round(a.y) - Math.round(b.y) || a.x - b.x)
      .map((box) => box.index);
    expect(visual).toEqual(list.map((_, index) => index));
    expect(await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
});

test("columns mirror in a right-to-left page while the reading order stays the same", async ({ page: tab }) => {
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.setContent(arrangedPage({ layout: "point-counterpoint", turns: duet.slice(0, 2), dir: "rtl" }));
  const [first, second] = await boxes(tab);
  expect(first.x).toBeGreaterThan(second.x);
  expect(await readingOrder(tab)).toEqual(["ANN-ONE", "BO-ONE"]);
});

test("without styles or scripts the new layouts keep each heading, label and turn in reading order", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const tab = await context.newPage();
  for (const layout of ["point-counterpoint", "alternating-dialogue", "roundtable"]) {
    await tab.setContent(arrangedPage({ layout, turns: duet, css: false }));
    expect(await tab.locator("h2.ob-turn-author").allTextContents()).toEqual(["Ann", "Bo", "Ann", "Bo", "Ann"]);
    const text = await tab.locator("article").innerText();
    const marks = ["What stood out?", "ANN-ONE", "BO-ONE", "ANN-TWO", "BO-TWO", "ANN-THREE"].map((mark) => text.indexOf(mark));
    expect([...marks].sort((a, b) => a - b)).toEqual(marks);
    expect(text.indexOf("Point")).toBeLessThan(text.indexOf("ANN-ONE"));
  }
  await context.close();
});

test("a hostile label is shown as text and cannot add elements or leave its turn", async ({ page: tab }) => {
  const hostile = "&lt;img src=x onerror=alert(1)&gt;&lt;/section&gt;";
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.setContent(arrangedPage({ layout: "point-counterpoint", turns: [{ lane: 0, name: "Ann", body: "ANN-ONE", label: hostile }, { lane: 1, name: "Bo", body: "BO-ONE" }] }));
  await expect(tab.locator(".ob-turn-label")).toHaveText("<img src=x onerror=alert(1)></section>");
  expect(await tab.locator("img").count()).toBe(0);
  expect(await tab.locator(".ob-turn").count()).toBe(2);
});
