// Simple view (#345, #346, ADR 0013) in the real app: the layout a household
// admin chooses for a Limited member. The switch and its cache are covered
// by the server and household drills; here the layout is applied as an
// unlock with the cached flag would, on this unsynced test household.
// Afterwards the page reloads into the full layout.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";

export async function simpleRegressions(client, { until, ready }) {
  const page = (expression) => client.evaluate(expression);

  const setup = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const me = app.ctx.detail.responsibilityContext().memberId;
    const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const socks = hex(), other = hex();
    await app.ctx.append.appendCommand({ type: "add", id: socks, text: "Simple regression socks away", classification: "need" });
    await app.ctx.append.appendCommand({ type: "add", id: other, text: "Simple regression not mine", classification: "need" });
    await app.ctx.append.appendCommand({ type: "change-responsibility", targetKind: "item", id: socks, memberId: me });
    await app.ctx.append.appendCommand({ type: "set-item-emoji", itemId: socks, emoji: "🧦" });
    app.ctx.render.renderState();
    await app.ctx.simple.refreshPictures();
    // The adult view: the picture sits beside the words, and details set it.
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    app.ctx.navigation.navigate("#lists/todo");
    for (let i = 0; i < 300 && !app.needs.querySelector('kin-item .item-emoji'); i++) await frame();
    const row = [...app.needs.querySelectorAll("kin-item")].find((node) => node.record?.itemId === socks);
    const adult = { emoji: row?.querySelector(".item-emoji")?.textContent ?? null, text: row?.querySelector(".item-text")?.textContent ?? null };
    app.ctx.detail.openItemDetail(other);
    for (let i = 0; i < 300 && !app.detail.querySelector(".item-picture-input"); i++) await frame();
    const input = app.detail.querySelector(".item-picture-input");
    input.value = "⚽";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    app.detail.querySelector(".item-picture-save").click();
    for (let i = 0; i < 600 && app.itemEmojis?.get(other) !== "⚽"; i++) await frame();
    const picked = { emoji: app.itemEmojis?.get(other) ?? null, status: app.status.textContent, clear: Boolean(app.detail.querySelector(".item-picture-clear")) };
    app.ctx.detail.closeItemDetail({ restoreFocus: false });
    location.hash = "#lists/shopping";
    // This test household doesn't sync, so it has no chat or fridge room and
    // Simple view would offer Today alone. Check that, then stand in for
    // open rooms so the three-destination layout can be checked too.
    app.ctx.simple.enter();
    const alone = { nav: [...app.navLinks.values()].filter((link) => !link.hidden).map((link) => link.textContent.trim()),
      single: app.nav.classList.contains("simple-nav-single") };
    app.ctx.navigation.navigate("#updates/chat");
    alone.chat = app.route.canonical;
    app.ctx.simple.access = () => ({ chat: true, fridge: true });
    app.ctx.simple.updateAccess();
    app.ctx.render.renderState();
    return { me, socks, adult, picked, alone };
  })()`);
  assert.deepEqual(setup.adult, { emoji: "🧦", text: "Simple regression socks away" }, "the adult row shows the emoji beside, not instead of, the text");
  assert.equal(setup.picked.emoji, "⚽", "an adult sets a picture from item details");
  assert.match(setup.picked.status, /^Picture saved\./);
  assert.ok(setup.picked.clear, "and can remove it");
  assert.deepEqual(setup.alone, { nav: ["Today"], single: true, chat: "today" }, "without rooms: Today alone, no navigation bar, Chat unreachable");
  await until(() => page(`document.querySelector("kin-simple")?.querySelectorAll(".simple-card").length > 0`), { attempts: 300 });

  const shell = await page(`(() => {
    const app = document.querySelector("kin-app");
    const visible = (node) => node && !node.hidden && node.getClientRects().length > 0;
    return {
      flag: document.documentElement.dataset.kinSimple,
      pages: [...app.pages.keys()],
      mounted: ["lists", "routines", "search"].filter((id) => document.getElementById(id)),
      nav: [...app.navLinks.values()].filter(visible).map((link) => [link.textContent.trim(), link.getAttribute("href")]),
      quickAdd: visible(app.quickAdd), search: visible(app.searchLink), lock: visible(app.lockButton),
      hash: location.hash,
      cards: [...document.querySelectorAll("kin-simple .simple-card")].map((card) => ({
        text: card.querySelector(".simple-text").textContent,
        emoji: card.querySelector(".simple-emoji")?.textContent ?? null,
        button: card.querySelector("button").getAttribute("aria-label"),
      })),
      // Everything but the things' own words and tonight's dinner: no numbers.
      counts: (() => { const copy = document.querySelector("kin-simple").cloneNode(true);
        copy.querySelectorAll(".simple-text, .simple-tonight").forEach((node) => node.remove());
        return /\\d/.test(copy.textContent); })(),
    };
  })()`);
  assert.equal(shell.flag, "on");
  assert.deepEqual(shell.pages, ["today", "updates", "household", "chores"], "only Today, Chat, the Fridge and the chore chart (#676)");
  assert.deepEqual(shell.mounted, [], "no other page is in the document");
  assert.deepEqual(shell.nav, [["Today", "#today"], ["Chat", "#updates/chat"], ["Fridge", "#household/fridge"]]);
  assert.ok(!shell.quickAdd && !shell.search && shell.lock, "Quick add and Search are off; Lock stays");
  assert.equal(shell.hash, "#today", "a hidden page's address goes to Today");
  // Earlier suites leave other things assigned to this member; check ours.
  assert.deepEqual(shell.cards.find((card) => card.text === "Simple regression socks away"),
    { text: "Simple regression socks away", emoji: "🧦", button: "Done: Simple regression socks away" }, "my thing, with its picture: " + JSON.stringify(shell.cards));
  assert.ok(!shell.cards.some((card) => card.text === "Simple regression not mine"), "not someone else's");
  assert.equal(shell.counts, false, "no counts or totals");

  // Every other route, the palette and item details stay closed.
  const closed = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const reached = [];
    for (const hash of ["#lists", "#routines", "#search", "#household/people", "#updates/handoffs", "#more/security"]) {
      app.ctx.navigation.navigate(hash);
      if (app.route.canonical !== "today") reached.push(hash);
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, metaKey: true, bubbles: true }));
    // Turning a chat message into a record is off too.
    app.ctx.chatShare.open({ kind: "todo", text: "From chat" });
    const shared = await app.ctx.chatShare.save({ kind: "todo", text: "From chat" });
    const shareOpen = Boolean(app.chatShare?.querySelector?.("dialog[open]"));
    app.ctx.detail.openItemDetail(${JSON.stringify(setup.socks)});
    return { reached, palette: Boolean(app.commandPalette?.isOpen), selection: app.selection, shareOpen, shared: shared.ok,
      added: app.state.items.some((item) => item.text === "From chat") };
  })()`);
  assert.deepEqual(closed, { reached: [], palette: false, selection: null, shareOpen: false, shared: false, added: false });
  for (const [hash, canonical] of [["#updates/chat", "updates/chat"], ["#household/fridge", "household/fridge"], ["#today", "today"]]) {
    await page(`document.querySelector("kin-app").ctx.navigation.navigate(${JSON.stringify(hash)})`);
    assert.equal(await page(`document.querySelector("kin-app").route.canonical`), canonical);
  }

  // Done, then Undo in the same place; the status says so politely.
  const card = `[...document.querySelectorAll("kin-simple .simple-card")].find((node) => node.querySelector(".simple-text").textContent === "Simple regression socks away")`;
  // A tap focuses the button; a scripted click doesn't, so focus it first.
  await page(`(() => { const done = ${card}.querySelector(".simple-done"); done.focus(); done.click(); return true; })()`);
  await until(() => page(`(() => { const app = document.querySelector("kin-app");
    return !app.busy && ${card}?.querySelector(".simple-undo") && /^Marked “Simple regression socks away” done\\./.test(app.status.textContent); })()`), { attempts: 300 });
  const done = await page(`(() => {
    const app = document.querySelector("kin-app");
    const undo = ${card}.querySelector(".simple-undo");
    return { label: undo.getAttribute("aria-label"), focused: document.activeElement === undo, height: undo.getBoundingClientRect().height,
      completed: app.state.items.find((item) => item.text === "Simple regression socks away").status };
  })()`);
  assert.equal(done.label, "Undo: Simple regression socks away");
  assert.equal(done.completed, "completed");
  assert.ok(done.focused, "focus stays on the card's button");
  // 1/64 px of layout rounding (the Help button above shifts the cards by a
  // fraction of a pixel) is not a smaller target.
  assert.ok(done.height >= 56 - 1 / 32, `the button is at least 56px tall (${done.height})`);
  await page(`${card}.querySelector(".simple-undo").click()`);
  await until(() => page(`(() => { const app = document.querySelector("kin-app");
    return !app.busy && ${card}?.querySelector(".simple-done") && /not done/.test(app.status.textContent); })()`), { attempts: 300 });

  // Layout (#350): one column and a bottom bar on a phone, a grid wider;
  // nothing scrolls sideways; at 200% text the picture stacks above the words.
  const socksCard = `[...document.querySelectorAll("kin-simple .simple-card")].find((node) => node.querySelector(".simple-text").textContent === "Simple regression socks away")`;
  for (const [label, metrics, phone] of [
    ["phone", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }, true],
    ["tablet", { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true }, false],
    ["tablet landscape", { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true }, false],
    ["desktop", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, false],
    ["desktop at 200%", { width: 640, height: 400, deviceScaleFactor: 2, mobile: false }, true],
  ]) {
    await setViewport(client, metrics);
    await page(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    const view = await page(`(() => {
      const card = ${socksCard};
      const picture = card.querySelector(".simple-picture").getBoundingClientRect();
      const text = card.querySelector(".simple-text").getBoundingClientRect();
      const lefts = new Set([...document.querySelectorAll("kin-simple .simple-card")].map((node) => Math.round(node.getBoundingClientRect().left)));
      const small = [...document.querySelectorAll("kin-simple button, .primary-nav a")].filter((node) => !node.hidden && node.getClientRects().length && node.getBoundingClientRect().height < 44);
      return { scroll: document.documentElement.scrollWidth, width: innerWidth, picture: Math.round(picture.width),
        stacked: picture.bottom <= text.top + 1, columns: lefts.size, small: small.length,
        nav: document.querySelector(".primary-nav").getBoundingClientRect().top > innerHeight / 2 };
    })()`);
    assert.ok(view.scroll <= view.width, `${label}: no horizontal scroll (${view.scroll} > ${view.width})`);
    assert.ok(view.picture >= (metrics.width < 720 ? 96 : 128), `${label}: the picture is large (${view.picture}px)`);
    assert.equal(view.small, 0, `${label}: every control is at least 44px tall`);
    if (phone) assert.ok(view.nav && view.columns === 1, `${label}: one column and a bottom bar`);
    if (metrics.width >= 720 || metrics.width <= 320) assert.ok(view.stacked, `${label}: the picture sits above the words`);
  }

  // Dark and forced colours (#350): the cards use the palette; Done and the
  // done state stay visible without colour.
  const colours = () => page(`(() => {
    const card = ${socksCard};
    const style = getComputedStyle(card);
    return { surface: style.getPropertyValue("--surface").trim(), border: style.borderTopStyle, width: parseFloat(style.borderTopWidth) };
  })()`);
  // Light against dark in the same palette, not the machine's own appearance
  // or the page's unstyled defaults (#795).
  await setMedia(client);
  await page(`(() => { const app = document.querySelector("kin-app"); if (!app.currentAppearance) app.ctx.appearance.applyEffectiveAppearance();
    window.__simpleAppearance = structuredClone(app.currentAppearance); app.ctx.appearance.applyAppearance({ ...window.__simpleAppearance, mode: "light" }); return true; })()`);
  const light = await colours();
  await page(`(() => { document.querySelector("kin-app").ctx.appearance.applyAppearance({ ...window.__simpleAppearance, mode: "dark" }); return true; })()`);
  const dark = await colours();
  await page(`(() => { const app = document.querySelector("kin-app"); app.ctx.appearance.applyAppearance(window.__simpleAppearance); delete window.__simpleAppearance; return true; })()`);
  assert.notEqual(dark.surface, light.surface, "dark mode changes the cards");
  await setMedia(client, [{ name: "forced-colors", value: "active" }]);
  const forced = await colours();
  await setMedia(client);
  assert.ok(forced.width >= 2 && forced.border !== "none", "forced colours: each card keeps a visible border");

  // Keyboard only and names (#350): Tab reaches Done; Enter marks it done;
  // Undo keeps focus; pictures are hidden from screen readers.
  await setViewport(client, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page(`(() => { const done = ${socksCard}.querySelector("button"); done.focus(); return document.activeElement === done; })()`);
  for (const type of ["keyDown", "keyUp"])
    await client.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
  await until(() => page(`(() => { const app = document.querySelector("kin-app"); const card = ${socksCard};
    return !app.busy && card?.querySelector(".simple-undo") && document.activeElement === card.querySelector(".simple-undo"); })()`), { attempts: 300 });
  const names = await page(`(() => ({
    pictures: [...document.querySelectorAll("kin-simple .simple-picture")].every((node) => node.getAttribute("aria-hidden") === "true"),
    images: [...document.querySelectorAll("kin-simple img")].every((img) => img.getAttribute("alt") === ""),
    list: document.querySelector("kin-simple .simple-cards").getAttribute("aria-label"),
    heading: document.getElementById("today-title")?.textContent,
  }))()`);
  assert.deepEqual(names, { pictures: true, images: true, list: "My things today", heading: "Today" });
  await page(`${socksCard}.querySelector(".simple-undo").click()`);
  await until(() => page(`(() => !document.querySelector("kin-app").busy && ${socksCard}?.querySelector(".simple-done"))()`), { attempts: 300 });
  await client.send("Emulation.clearDeviceMetricsOverride");

  // Back to the full layout for the rest of the run.
  await client.send("Page.reload");
  await ready(client);
  const full = await page(`(() => ({ flag: document.documentElement.dataset.kinSimple ?? null, lists: Boolean(document.getElementById("lists")) }))()`);
  assert.deepEqual(full, { flag: null, lists: true });
  return "PASS Simple view and item pictures: an adult sets a picture beside the words; only Today, Chat and the Fridge; no palette, details, Quick add or Search; my things with pictures; Done and Undo in place; 320×568 to desktop and 200% text, dark and forced colours, keyboard and names (#345–#347, #350)";
}
