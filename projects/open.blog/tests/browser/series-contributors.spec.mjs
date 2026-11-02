import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Contributor-aware series navigation (ADR 0040). The markup is what the renderer writes for a
// series that holds a collaborative work (crates/openblog-core/src/render.rs, `series_box` and
// `series_page`); the styles are the real public stylesheet. Everything works with scripts off.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const styles = readFileSync(join(repository, "web", "base.css"), "utf8");

const LONG_NAMES = "By Annabelle Featherstonehaugh-Montgomery, Bartholomew Wolfeschlegelsteinhausen, and Cy";

const seriesBox = `<aside class="ob-series-box" aria-label="Series navigation">
<p class="ob-eyebrow">Part 2 of 4 in <a href="/series/letters/">Letters</a></p>
<div class="ob-series-nav"><a class="ob-series-prev" rel="prev" href="/l1/"><span class="ob-meta">Previous part</span><span>Part l1</span><span class="ob-meta ob-part-credit">By Site Owner</span></a><a class="ob-series-next" rel="next" href="/l3/"><span class="ob-meta">Next part</span><span>Part l3</span><span class="ob-meta ob-part-credit">${LONG_NAMES}</span></a></div>
<details class="ob-series-parts-details"><summary>All parts</summary><ol class="ob-series-parts"><li><a href="/l1/">Part l1</a> <span class="ob-meta ob-part-credit">By Site Owner</span></li><li><a href="/l2/" aria-current="page">Part l2</a> <span class="ob-meta ob-part-credit">By Ann, Bo, and Cy</span></li><li><a href="/l3/">Part l3</a> <span class="ob-meta ob-part-credit">${LONG_NAMES}</span></li><li><a href="/l4/">Part l4</a> <span class="ob-meta ob-part-credit">By Site Owner</span></li></ol></details>
</aside>`;

const part = (n, slug, by) =>
  `<li><a class="ob-part" href="/${slug}/"><span class="ob-part-number" aria-hidden="true">0${n}</span><span class="ob-part-body"><span class="ob-part-title">Part ${slug}</span><span class="ob-part-summary">About ${slug}.</span><span class="ob-meta"><span class="ob-part-credit">${by}</span> · <time datetime="2026-04-01T00:00:00Z">Apr 1, 2026</time> · 1 min read</span></span></a></li>`;

const seriesPage = `<div class="ob-container ob-container-reading">
<section class="ob-section">
<p class="ob-eyebrow"><a href="/series/">Series</a></p>
<div class="ob-heading ob-section-heading"><h1 class="ob-title">Letters</h1></div>
<p class="ob-meta ob-series-contributors">Contributors: Site Owner, Ann, Bo, Cy, and Dee</p>
<ol class="ob-series-parts ob-series-parts-full">
${part(1, "l1", "By Site Owner")}
${part(2, "l2", "By Ann, Bo, and Cy")}
${part(3, "l3", LONG_NAMES)}
${part(4, "l4", "By Site Owner")}
</ol>
</section>
</div>`;

const doc = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head>
<body><main>${body}</main></body></html>`;

async function noScripts(browser) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  return { context, tab: await context.newPage() };
}

test("previous and next name whose part they lead to, in the link itself, with scripts off", async ({ browser }) => {
  const { context, tab } = await noScripts(browser);
  await tab.setContent(doc(`<article><p>Body.</p>${seriesBox}</article>`));
  const nav = tab.getByRole("complementary", { name: "Series navigation" });
  await expect(nav).toBeVisible();
  // Each span is a flex item, so the browser may or may not put a space between them in the name.
  await expect(nav.getByRole("link", { name: /Previous part\s*Part l1\s*By Site Owner/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Next part\s*Part l3\s*By Annabelle/ })).toBeVisible();
  // Keyboard: the series link, then previous, then next, then the native disclosure.
  await tab.keyboard.press("Tab");
  await expect(tab.locator(":focus")).toHaveText("Letters");
  await tab.keyboard.press("Tab");
  await expect(tab.locator(":focus")).toHaveAttribute("rel", "prev");
  await tab.keyboard.press("Tab");
  await expect(tab.locator(":focus")).toHaveAttribute("rel", "next");
  await tab.keyboard.press("Tab");
  await tab.keyboard.press("Enter");
  await expect(nav.locator("details")).toHaveAttribute("open", "");
  await expect(nav.getByRole("link", { name: "Part l2" })).toHaveAttribute("aria-current", "page");
  await expect(nav.locator(".ob-series-parts li").nth(1)).toHaveText("Part l2 By Ann, Bo, and Cy");
  await context.close();
});

test("long credits wrap on a narrow screen without sideways scrolling", async ({ browser }) => {
  const { context, tab } = await noScripts(browser);
  await tab.setViewportSize({ width: 320, height: 800 });
  await tab.setContent(doc(`<article>${seriesBox}</article>${seriesPage}`));
  await tab.locator("details summary").click();
  const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Previous and next never overlap.
  // On a narrow screen they may stack, so check the boxes do not intersect.
  const [prev, next] = await tab.evaluate(() =>
    [".ob-series-prev", ".ob-series-next"].map((selector) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  const apart = prev.x + prev.width <= next.x + 1 || prev.y + prev.height <= next.y + 1;
  expect(apart, "previous and next overlap").toBe(true);
  await context.close();
});

test("the series page lists contributors before the parts, and each part's authors in its link", async ({ browser }) => {
  const { context, tab } = await noScripts(browser);
  await tab.setContent(doc(seriesPage));
  const contributors = tab.locator(".ob-series-contributors");
  await expect(contributors).toHaveText("Contributors: Site Owner, Ann, Bo, Cy, and Dee");
  const list = tab.getByRole("list");
  const above = await tab.evaluate(() =>
    document.querySelector(".ob-series-contributors").compareDocumentPosition(document.querySelector(".ob-series-parts")) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(above).toBeTruthy();
  await expect(list.getByRole("link", { name: /Part l2\s*About l2\.\s*By Ann, Bo, and Cy/ })).toBeVisible();
  const order = await tab.evaluate(() => [...document.querySelectorAll(".ob-part")].map((link) => link.getAttribute("href")));
  expect(order).toEqual(["/l1/", "/l2/", "/l3/", "/l4/"]);
  await context.close();
});
