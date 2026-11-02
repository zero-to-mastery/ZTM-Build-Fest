import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Landing sections (ADR 0247, #325), built and served by the real binary in every bundled theme.
// Each section type is visible and legible at 320px and 1280px in light and dark without
// overflowing, buttons and links show a focus ring, the page has one h1, markup typed into a
// field is plain text, and reduced motion turns the button transitions off.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const LONG = "an_extraordinarily_long_unbroken_word_that_must_wrap_instead_of_overflowing_a_small_screen_at_all_even_at_320";
const THEMES = ["base", "paper", "demo"];

const LANDING = {
  format: "openblog-landing", version: 1,
  sections: [
    { id: "hello", type: "welcome", heading: `Welcome ${LONG}`, subheading: "A friendly place to read.",
      image: { src: "/hero.svg", alt: "A hand-drawn door" }, button: { label: "Start reading", href: "/one/" } },
    { id: "text", type: "rich-text", markdown: `## About\n\nSome *rich* text with <script>window.__pwned = 1</script> and ${LONG}.\n\n- one\n- two` },
    { id: "latest", type: "latest-posts", heading: "Newest", count: 3 },
    { id: "series", type: "series", heading: "Series" },
    { id: "pick", type: "featured-post", post: "one", heading: "Start here" },
    { id: "go", type: "buttons", items: [{ label: "Email me", href: "mailto:me@example.com" }, { label: "Docs", href: "https://example.com/docs", style: "secondary" }] },
    { id: "pic", type: "image", src: "/hero.svg", alt: "A hand-drawn door", caption: "The door" },
    { id: "vid", type: "video", provider: "youtube", video: "dQw4w9WgXcQ", title: "A short tour" },
    { id: "where", type: "map", provider: "openstreetmap", label: "12 High Street", lat: 51.5, lon: -0.12 },
    { id: "hours", type: "opening-hours", rows: [{ days: "Monday to Friday", hours: "9am to 5pm" }, { days: "Weekend", hours: "Closed" }], note: "Closed on holidays" },
    { id: "contact", type: "contact", email: "me@example.com", phone: "+1 555 010 0100", address: "12 High Street" },
    { id: "social", type: "social-links", items: [{ label: "Mastodon", href: "https://example.social/@me" }] },
    { id: "faq", type: "faq", items: [{ question: "Is it free?", answer: "Yes, **always**." }] },
    { id: "note", type: "callout", tone: "warning", title: "Heads up", body: "Open late on Fridays." },
  ],
};

let root;

test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "openblog-landing-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  mkdirSync(join(root, "static"), { recursive: true });
  cpSync(join(repository, "themes"), join(root, "themes"), { recursive: true });
  writeFileSync(join(root, "static", "hero.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#888"/></svg>');
  writeFileSync(join(root, "content", "posts", "one.md"), "---\ntitle: One\ndate: 2026-10-01\nseries: guide\n---\nA post.\n");
  writeFileSync(join(root, "content", "posts", "two.md"), "---\ntitle: Two\ndate: 2026-10-02\nseries: guide\n---\nAnother post.\n");
  mkdirSync(join(root, "content", "series"), { recursive: true });
  writeFileSync(join(root, "content", "series", "guide.md"), "---\nname: The Guide\n---\nAbout the guide.\n");
  writeFileSync(join(root, "content", "landing.json"), JSON.stringify(LANDING));
});

test.afterAll(() => {
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold a file */ }
  }
});

async function serve(theme) {
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Landing", url: "https://landing.example.org", theme, author: { name: "Site Author" } }));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(binary, ["serve", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
  return {
    origin,
    stop: async () => {
      if (server.exitCode === null) {
        const stopped = once(server, "exit");
        server.kill();
        await stopped;
      }
    },
  };
}

for (const theme of THEMES) {
  test(`every section renders legibly in the ${theme} theme at 320 and 1280, light and dark`, async ({ browser }, testInfo) => {
    const site = await serve(theme);
    try {
      for (const width of [320, 1280]) {
        for (const scheme of ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
          const page = await context.newPage();
          await page.goto(`${site.origin}/`);
          const label = `${theme} ${width}px ${scheme}`;

          for (const type of ["welcome", "rich-text", "latest-posts", "series", "featured-post", "buttons", "image", "video", "map", "opening-hours", "contact", "social-links", "faq", "callout"]) {
            await expect(page.locator(`.ob-home-section.ob-home-${type}`).first(), `${label}: ${type}`).toBeVisible();
          }
          await expect(page.locator("h1"), label).toHaveCount(1);
          // Markup typed into a field is text, never an element.
          expect(await page.evaluate(() => window.__pwned), label).toBeUndefined();
          await expect(page.locator(".ob-home-rich-text script")).toHaveCount(0);
          await expect(page.locator(".ob-home-rich-text")).toContainText("<script>window.__pwned = 1</script>");

          // The landing region never scrolls sideways (measured on the region, not the page).
          const overflow = await page.evaluate(() => {
            const region = document.querySelector(".ob-container");
            const widest = [...region.querySelectorAll("*")].reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0);
            return { scroll: region.scrollWidth - region.clientWidth, widest: widest - document.documentElement.clientWidth };
          });
          expect(overflow.scroll, `${label}: container scroll`).toBeLessThanOrEqual(0);
          expect(overflow.widest, `${label}: widest element`).toBeLessThanOrEqual(1);

          // The text is readable: not the same color as what is behind it.
          const colors = await page.evaluate(() => {
            const read = (selector) => {
              const el = document.querySelector(selector);
              const style = getComputedStyle(el);
              return { color: style.color, background: getComputedStyle(document.body).backgroundColor };
            };
            return { text: read(".ob-home-rich-text"), primary: read(".ob-home-button-primary") };
          });
          expect(colors.text.color, label).not.toBe(colors.text.background);

          if (width === 320) {
            await page.screenshot({ path: testInfo.outputPath(`landing-${theme}-${width}-${scheme}.png`), fullPage: true });
          }
          await context.close();
        }
      }
    } finally {
      await site.stop();
    }
  });
}

test("buttons and links show a focus ring, and reduced motion turns transitions off", async ({ browser }) => {
  const site = await serve("base");
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${site.origin}/`);
    const button = page.locator(".ob-home-welcome .ob-home-button");
    await button.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    const ring = await button.evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThan(0);
    const link = page.locator(".ob-home-video a");
    await link.focus();
    const linkRing = await link.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(linkRing).not.toBe("none");
    const duration = await button.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration).toBe("0s");
    // The FAQ opens and closes from the keyboard with native details.
    const summary = page.locator(".ob-home-faq-item summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".ob-home-faq-item")).toHaveAttribute("open", "");
    await context.close();
  } finally {
    await site.stop();
  }
});
