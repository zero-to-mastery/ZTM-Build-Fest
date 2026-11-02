// Chat fits the screen (#310, #311) in a real browser, on the room the chat
// suite leaves behind (500 messages): the page doesn't scroll, the message
// list does; Chat opens at the latest message; the one-row composer stays in
// view above the phone's bottom bar, and above the keyboard (emulated by a
// shorter viewport while the message box has focus); jump to latest works.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";

export async function chatLayoutRegressions(client, { until }) {
  const page = (expression) => client.evaluate(expression);
  const frames = () => page(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`);
  await page(`(() => { const app = document.querySelector("kin-app"); app.ctx.navigation.navigate("#updates/chat"); return true; })()`);
  await frames();
  const measure = () => page(`(() => {
    const chat = document.querySelector("kin-app kin-chat");
    const scroller = chat.querySelector(".chat-scroll");
    const form = chat.querySelector(".chat-form").getBoundingClientRect();
    const row = chat.querySelector(".chat-compose-row").getBoundingClientRect();
    const nav = document.querySelector(".primary-nav");
    const navRect = nav && getComputedStyle(nav).position === "fixed" && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect() : null;
    const visible = window.visualViewport ? visualViewport.height : innerHeight;
    return {
      fit: chat.querySelector(".chat-section").classList.contains("chat-fit"),
      pageScroll: document.documentElement.scrollHeight - innerHeight,
      sideways: document.documentElement.scrollWidth - innerWidth,
      atLatest: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4,
      list: scroller.clientHeight, visible,
      composerBottom: Math.round(form.bottom), rowHeight: Math.round(row.height),
      navTop: navRect ? Math.round(navRect.top) : null,
      // For a failure message: what takes the room.
      section: Math.round(chat.querySelector(".chat-section").getBoundingClientRect().top) + "+" + Math.round(chat.querySelector(".chat-section").getBoundingClientRect().height),
      parts: [...chat.querySelector(".chat-section").children].filter((node) => node.getClientRects().length)
        .map((node) => (node.className || node.tagName).split(" ")[0] + ":" + Math.round(node.getBoundingClientRect().height)).join(" "),
    };
  })()`);

  // Opening Chat lands on the newest message, without help (#310).
  await page(`(() => { document.querySelector("kin-app").ctx.navigation.navigate("#updates/handoffs"); return true; })()`);
  await frames();
  await page(`(() => { document.querySelector("kin-app").ctx.navigation.navigate("#updates/chat"); return true; })()`);
  await frames();
  const opened = await measure();
  assert.ok(opened.atLatest, `opening Chat shows the newest message ${JSON.stringify(opened)}`);

  for (const [label, metrics] of [
    ["phone", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }],
    ["phone landscape", { width: 568, height: 320, deviceScaleFactor: 2, mobile: true }],
    ["tablet", { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true }],
    ["tablet landscape", { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true }],
    ["tablet portrait (820)", { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true }],
    ["desktop", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }],
    ["desktop at 200%", { width: 640, height: 400, deviceScaleFactor: 2, mobile: false }],
  ]) {
    await setViewport(client, metrics);
    await page(`(() => { scrollTo(0, 0); const s = document.querySelector("kin-app kin-chat .chat-scroll"); s.scrollTop = s.scrollHeight; return true; })()`);
    await frames();
    await page(`(() => { const s = document.querySelector("kin-app kin-chat .chat-scroll"); s.scrollTop = s.scrollHeight; return true; })()`);
    await frames();
    const view = await measure();
    const why = ` ${JSON.stringify(view)}`;
    assert.ok(view.fit, `${label}: the chat fits the screen${why}`);
    assert.ok(view.pageScroll <= 2, `${label}: the page itself doesn't scroll (${view.pageScroll}px)${why}`);
    assert.ok(view.sideways <= 0, `${label}: no horizontal scroll${why}`);
    assert.ok(view.composerBottom <= view.visible + 1, `${label}: the composer is in view (${view.composerBottom} of ${view.visible})${why}`);
    if (view.navTop !== null) assert.ok(view.composerBottom <= view.navTop + 1, `${label}: the composer sits above the bottom bar${why}`);
    assert.ok(view.rowHeight <= 120, `${label}: the composer is one row (${view.rowHeight}px)${why}`);
    assert.ok(view.atLatest, `${label}: showing the latest message${why}`);
  }

  // #316: at 320×568 with 200% text, dark mode and reduced motion, Chat
  // still fits, the composer stays in view, nothing scrolls sideways, and the
  // Updates tabs stay on one row.
  await setViewport(client, { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  for (const [label, features, bigText] of [
    ["200% text", [], true],
    ["dark mode", [{ name: "prefers-color-scheme", value: "dark" }], false],
    ["reduced motion", [{ name: "prefers-reduced-motion", value: "reduce" }], false],
  ]) {
    await setMedia(client, features);
    await page(`(() => { document.documentElement.style.fontSize = ${bigText ? '"200%"' : '""'}; scrollTo(0, 0); return true; })()`);
    await frames();
    await page(`(() => { const s = document.querySelector("kin-app kin-chat .chat-scroll"); s.scrollTop = s.scrollHeight; return true; })()`);
    await frames();
    const view = await measure();
    const why = ` ${JSON.stringify(view)}`;
    assert.ok(view.fit && view.pageScroll <= 2 && view.sideways <= 0, `${label}: Chat fits without page or sideways scroll${why}`);
    assert.ok(view.composerBottom <= view.visible + 1 && (view.navTop === null || view.composerBottom <= view.navTop + 1), `${label}: the composer is in view above the bar${why}`);
    const tabs = await page(`(() => {
      const app = document.querySelector("kin-app");
      app.ctx.navigation.navigate("#updates/handoffs");
      const links = [...app.segmentNavs.get("updates").querySelectorAll(".segment-link")];
      const tops = new Set(links.map((link) => Math.round(link.getBoundingClientRect().top)));
      const result = { count: links.length, rows: tops.size === 1 ? 1 : links.map((link) => { const box = link.getBoundingClientRect(); return [Math.round(box.left), Math.round(box.top), Math.round(box.width), getComputedStyle(link.closest("ul")).flexWrap].join("/"); }).join(" "), sideways: document.documentElement.scrollWidth - innerWidth,
        labelled: links.every((link) => { const count = link.querySelector(".segment-count"); return !count || /[a-z]/i.test(count.getAttribute("aria-label") ?? ""); }) };
      app.ctx.navigation.navigate("#updates/chat");
      return result;
    })()`);
    assert.deepEqual(tabs, { count: 2, rows: 1, sideways: 0, labelled: true }, `${label}: Updates shows two tabs on one row at 320px`);
    if (label === "reduced motion")
    {
      const durations = await page(`[...document.querySelectorAll("kin-app kin-chat .chat-menu-wrap")].slice(-3).map((node) => getComputedStyle(node).transitionDuration).join("|")`);
      assert.ok(durations.split(/[|,]/).every((value) => Number.parseFloat(value) <= 0.001), `reduced motion: no fade on message tools (${durations})`);
    }
    await frames();
  }
  await page(`(() => { document.documentElement.style.fontSize = ""; return true; })()`);
  await setMedia(client);

  // A phone with the keyboard open: the message box has focus and the
  // visible height shrinks; the bottom bar steps aside, the list keeps room.
  await setViewport(client, { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await setMedia(client, [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }]).catch(() => {});
  await page(`(() => { document.querySelector("kin-app kin-chat textarea").focus(); return true; })()`);
  await setViewport(client, { width: 320, height: 300, deviceScaleFactor: 2, mobile: true });
  await frames();
  const typing = await measure();
  const composing = await page(`document.documentElement.hasAttribute("data-chat-composing")`);
  assert.ok(composing, "focusing the message box marks the page as composing");
  assert.ok(typing.composerBottom <= typing.visible + 1, `keyboard open: the composer stays above it (${typing.composerBottom} of ${typing.visible})`);
  assert.ok(typing.list >= typing.visible * 0.4, `keyboard open: the list keeps at least 40% of the screen (${typing.list} of ${typing.visible})`);
  await page(`(() => { document.activeElement?.blur(); return true; })()`);
  await setMedia(client).catch(() => {});
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  // Scrolled up, Jump to latest appears and takes you back.
  await setViewport(client, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page(`(() => { const s = document.querySelector("kin-app kin-chat .chat-scroll"); s.scrollTop = 0; s.dispatchEvent(new Event("scroll")); return true; })()`);
  await until(() => page(`!document.querySelector("kin-app kin-chat .chat-jump").hidden`), { attempts: 200 });
  await page(`(() => { document.querySelector("kin-app kin-chat .chat-jump").click(); return true; })()`);
  await until(() => page(`(() => { const s = document.querySelector("kin-app kin-chat .chat-scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 4; })()`), { attempts: 300 });

  // The + menu holds photo, file, camera and poll; Escape returns to +.
  const menu = await page(`(() => {
    const chat = document.querySelector("kin-app kin-chat");
    const more = chat.querySelector(".chat-more");
    more.click();
    const open = !chat.querySelector(".chat-add-menu").hidden && more.getAttribute("aria-expanded") === "true";
    const inside = document.activeElement?.closest?.(".chat-add-menu") !== null;
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return { open, inside, closed: chat.querySelector(".chat-add-menu").hidden, back: document.activeElement === more,
      voice: !chat.querySelector(".chat-voice-open").hidden, send: chat.querySelector(".chat-form .add-button").hidden };
  })()`);
  assert.deepEqual(menu, { open: true, inside: true, closed: true, back: true, voice: true, send: true }, "the + menu, and Voice while the box is empty");

  // Message actions (#311). With a mouse: the last message's ⋯ opens the
  // sheet by it, flipped above (it's near the composer); Escape returns to ⋯.
  // Right-click opens it too, and a backdrop click closes it.
  const sheetAt = await page(`(() => {
    const chat = document.querySelector("kin-app kin-chat");
    const row = [...chat.querySelectorAll(".chat-row")].findLast((node) => node.querySelector(".chat-menu-button"));
    const button = row.querySelector(".chat-menu-button");
    button.click();
    const sheet = chat.querySelector(".chat-action-sheet");
    const box = sheet.getBoundingClientRect(), at = button.getBoundingClientRect();
    const result = { open: sheet.open, bottomSheet: sheet.classList.contains("chat-sheet-bottom"),
      clear: box.bottom <= at.top + 1 || box.top >= at.bottom - 1, inView: box.top >= 0 && box.bottom <= innerHeight,
      focus: document.activeElement?.closest?.(".chat-menu") !== null, expanded: button.getAttribute("aria-expanded") };
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    result.closed = !sheet.open && !chat.querySelector(".chat-menu");
    result.back = document.activeElement?.classList.contains("chat-menu-button");
    row.querySelector(".chat-text").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    result.rightClick = sheet.open;
    sheet.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }));
    result.backdrop = !sheet.open;
    return result;
  })()`);
  assert.deepEqual(sheetAt, { open: true, bottomSheet: false, clear: true, inView: true, focus: true, expanded: "true", closed: true, back: true, rightClick: true, backdrop: true },
    "with a mouse the actions open by the ⋯ (above it near the bottom), close with Escape, open on right-click and close on the backdrop");

  // A touch screen at 320px: no action column, a 44px ⋯ in the time line; a
  // long press opens a bottom sheet with quick reactions first; a swipe
  // down closes it and focus returns to ⋯.
  await setViewport(client, { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await setMedia(client, [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }]);
  await frames();
  const touchRow = await page(`(() => {
    const chat = document.querySelector("kin-app kin-chat");
    const row = [...chat.querySelectorAll(".chat-row")].findLast((node) => node.querySelector(".chat-menu-button") && !node.classList.contains("grouped"));
    row.scrollIntoView({ block: "center" });
    const wrap = getComputedStyle(row.querySelector(".chat-menu-wrap"));
    const button = row.querySelector(".chat-menu-button").getBoundingClientRect();
    const react = row.querySelector(".chat-react-button");
    const text = row.querySelector(".chat-text").getBoundingClientRect();
    window.__touchRow = row.dataset.messageId;
    row.querySelector(".chat-text").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", isPrimary: true, button: 0, clientX: text.left + 5, clientY: text.top + 5 }));
    return { overlay: wrap.position === "absolute", target: button.width >= 44 && button.height >= 44, react: !react || getComputedStyle(react).display === "none" };
  })()`);
  assert.deepEqual(touchRow, { overlay: true, target: true, react: true }, "touch: no action column, a 44px ⋯, reactions in the sheet");
  await until(() => page(`document.querySelector("kin-app kin-chat .chat-action-sheet").open`), { attempts: 300 });
  const touchSheet = await page(`(() => {
    const chat = document.querySelector("kin-app kin-chat");
    const sheet = chat.querySelector(".chat-action-sheet");
    const row = chat.querySelector('.chat-row[data-message-id="' + window.__touchRow + '"]');
    row.querySelector(".chat-text").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", isPrimary: true }));
    const box = sheet.getBoundingClientRect();
    const view = visualViewport ? visualViewport.height : innerHeight;
    const result = { bottomSheet: sheet.classList.contains("chat-sheet-bottom"), anchored: Math.abs(box.bottom - view) <= 2, width: box.width <= 480,
      reactionsFirst: sheet.querySelector(".chat-sheet-reactions")?.compareDocumentPosition(sheet.querySelector(".chat-menu")) === Node.DOCUMENT_POSITION_FOLLOWING,
      targets: [...sheet.querySelectorAll("button")].every((node) => node.getBoundingClientRect().height >= 44) };
    sheet.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 100, clientY: box.top + 10 }));
    sheet.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", clientX: 100, clientY: box.top + 120 }));
    result.swiped = !sheet.open;
    result.back = document.activeElement === row.querySelector(".chat-menu-button");
    delete window.__touchRow;
    return result;
  })()`);
  assert.deepEqual(touchSheet, { bottomSheet: true, anchored: true, width: true, reactionsFirst: true, targets: true, swiped: true, back: true },
    "touch: a long press opens a bottom sheet, reactions first, 44px targets; a swipe down closes it and focus returns to ⋯");
  // A tablet held by touch: the sheet stays at most 480px wide.
  await setViewport(client, { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true });
  await frames();
  const tablet = await page(`(() => {
    const chat = document.querySelector("kin-app kin-chat");
    const row = [...chat.querySelectorAll(".chat-row")].findLast((node) => node.querySelector(".chat-menu-button"));
    row.querySelector(".chat-menu-button").click();
    const sheet = chat.querySelector(".chat-action-sheet");
    const width = sheet.getBoundingClientRect().width;
    sheet.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return { width: width <= 480, closed: !sheet.open };
  })()`);
  assert.deepEqual(tablet, { width: true, closed: true }, "touch tablet: the sheet is at most 480px wide");
  await setMedia(client);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  await client.send("Emulation.clearDeviceMetricsOverride");
  await page(`(async () => { await window.__chatCleanup?.(); delete window.__chatCleanup; return true; })()`);
  return "PASS chat fits the screen at 320×568 to desktop and 200%, opens at the latest message, keeps the one-row composer above the bar and the keyboard, jumps to latest, and the + menu, and message actions by mouse, right-click, long press and swipe (#310, #311)";
}
