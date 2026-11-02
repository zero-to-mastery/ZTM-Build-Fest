import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createVoiceLibrary } from "../../web/admin/voice-library.js";
import { createVoiceSession } from "../../web/admin/voice-session.js";
import { VOICE_LIMITS, createAnnouncer, createCountdown, timerLabel } from "../../web/admin/voice.js";
import { choose, type, withDom } from "./dom-shim.mjs";
import { accessibilityProblems, all, button, fakeClock, fakeServer, fakeStorage, flush, one, tabStops, text } from "./voice-harness.mjs";

// Timer announcements, focus order and reduced motion (ADR 0275, #450). The scan below is an axe-style check run
// on every step of the view; the announcements are tested at exact seconds.

const css = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");
const source = readFileSync(new URL("../../web/admin/voice-session.js", import.meta.url), "utf8");

let users = 0;
async function mount(extra = {}) {
  const clock = fakeClock();
  const api = fakeServer(clock);
  const heard = [];
  const session = createVoiceSession({ api, user: `a11y-${++users}`, clock, storage: () => fakeStorage(), onAnnounce: (message, at) => heard.push({ message, at }), ...extra });
  document.body.append(session.element);
  await session.load();
  await flush();
  return { clock, api, session, root: session.element, heard };
}
const radios = (root) => all(root, "input").filter((n) => n.attributes.type === "radio" && n.attributes.name?.endsWith("-prompt"));
async function startWriting(m) {
  const first = radios(m.root)[0];
  first.checked = true;
  await choose(first, first.value);
  await button(m.root, "voice-start").click();
  await flush();
}
const rough = (root) => all(root, "textarea").find((n) => n.dataset.voiceRough === "true");

test("the announcer says one minute and thirty seconds once each, then the lock, and never twice within thirty seconds", () => {
  const announcer = createAnnouncer();
  const said = [];
  for (let remaining = 180; remaining > 0; remaining -= 1) {
    const at = (180 - remaining) * 1000;
    const message = announcer.update(remaining, at);
    if (message) said.push({ message, at });
  }
  assert.deepEqual(said, [
    { message: "1 minute left.", at: 120000 },
    { message: "30 seconds left.", at: 150000 },
  ]);
  assert.equal(announcer.lock(true), "Time is up. Your rough draft is locked.");
  assert.equal(announcer.lock(true), null, "the lock is said once");
  for (let i = 1; i < said.length; i += 1) assert.ok(said[i].at - said[i - 1].at >= VOICE_LIMITS.announceGapMs);
});

test("a resumed session says where it stands once, and a mark inside thirty seconds of that is not repeated", () => {
  const late = createAnnouncer();
  assert.equal(late.update(20, 0), "Resumed. 20 seconds left.");
  assert.equal(late.update(19, 1000), null);
  const mid = createAnnouncer();
  assert.equal(mid.update(45, 0), "Resumed. 45 seconds left.");
  assert.equal(mid.update(30, 15000), null, "the thirty second mark would come only 15 seconds after the last message");
  const fresh = createAnnouncer();
  assert.equal(fresh.update(180, 0), null, "a new session says nothing until the first mark");
  assert.equal(createAnnouncer().update(0, 0), null);
});

test("the view's live region speaks the marks and the lock, and the clock is not itself live", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "writing against the clock";
    await type(box, box.value);
    const clockNode = one(m.root, "[data-voice-clock]");
    assert.equal(clockNode.attributes.role, "timer");
    assert.equal(clockNode.attributes["aria-live"], undefined, "a timer is not read out each second");
    assert.equal(clockNode.attributes["aria-label"], "Time remaining");
    const live = one(m.root, "[data-voice-announce]");
    assert.equal(live.attributes.role, "status");
    assert.equal(live.attributes["aria-live"], "polite");
    await m.clock.advance(180000);
    await flush();
    assert.deepEqual(
      m.heard.map((h) => h.message),
      ["1 minute left.", "30 seconds left.", "Time is up. Your rough draft is locked."],
    );
    const times = m.heard.map((h) => h.at);
    assert.ok(times[1] - times[0] >= 30000 && times[2] - times[1] >= 29000);
    assert.equal(text(live), "Time is up. Your rough draft is locked.", "the last message stays in the region, which outlives the step");
  })();
});

test("Finish early says the draft is locked without saying time is up", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "done early";
    await type(box, box.value);
    await button(m.root, "voice-finish").click();
    await flush();
    assert.deepEqual(m.heard.map((h) => h.message), ["Your rough draft is locked."]);
  })();
});

test("focus moves to the rough box on Start, to the polished editor on lock, and to the heading when starting over", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    assert.equal(document.activeElement, rough(m.root), "Start puts the cursor in the box");
    const box = rough(m.root);
    box.value = "words";
    await type(box, "words");
    await button(m.root, "voice-finish").click();
    await flush();
    assert.equal(document.activeElement, one(m.root, "[data-voice-polished-body]"), "the lock puts focus in the polished editor");
    await button(m.root, "voice-another").click();
    await flush();
    assert.equal(document.activeElement, one(m.root, "[data-voice-heading]"), "a new draw starts at its heading");
    assert.equal(one(m.root, "[data-voice-heading]").attributes.tabindex, "-1");
  })();
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    await button(m.root, "voice-over").click();
    assert.equal(document.activeElement, one(one(m.root, "[data-voice-scrap]"), "strong"));
    await button(m.root, "voice-over-confirm").click();
    await flush();
    assert.equal(document.activeElement, one(m.root, "[data-voice-heading]"));
  })();
});

test("the time running out also moves focus to the polished editor", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "the clock ran out";
    await type(box, box.value);
    await m.clock.advance(181000);
    await flush();
    assert.equal(document.activeElement, one(m.root, "[data-voice-polished-body]"));
  })();
});

test("every control is reachable by Tab in reading order, with no positive tabindex and nothing locked out", async () => {
  await withDom(async () => {
    const m = await mount();
    const draw = tabStops(m.root).map((n) => n.attributes.id || n.dataset.action || n.tagName);
    // The three prompts, the two places, the actions, in the order they read.
    assert.deepEqual(
      tabStops(m.root).filter((n) => n.tagName === "INPUT").map((n) => n.attributes.type),
      ["radio", "radio", "radio", "radio", "radio"],
    );
    assert.ok(draw.includes("voice-redraw") && draw.includes("voice-library"));
    assert.equal(button(m.root, "voice-start").disabled, true, "Start waits for a choice, and says so by being disabled");
    await startWriting(m);
    const stops = tabStops(m.root);
    assert.deepEqual(stops.map((n) => n.dataset.voiceRough ? "rough" : n.dataset.action), ["rough", "voice-finish", "voice-over"]);
    assert.equal(stops.length, all(m.root, "button, textarea, a, input").filter((n) => !n.disabled).length, "everything that can be used can be tabbed to");
    const box = rough(m.root);
    box.value = "words";
    await type(box, "words");
    await button(m.root, "voice-finish").click();
    await flush();
    const after = tabStops(m.root);
    assert.ok(!after.some((n) => n.dataset.voiceRough), "the locked rough text is not an input");
    assert.ok(after.some((n) => n.dataset.voiceRoughText), "but it can be reached and read with the keyboard");
    assert.ok(after.some((n) => n.dataset.voicePolishedTitle) && after.some((n) => n.dataset.voicePolishedBody));
  })();
});

test("each step passes the accessibility scan", async () => {
  await withDom(async () => {
    const m = await mount();
    assert.deepEqual(accessibilityProblems(m.root), [], "draw");
    await startWriting(m);
    assert.deepEqual(accessibilityProblems(m.root), [], "write");
    await button(m.root, "voice-over").click();
    assert.deepEqual(accessibilityProblems(m.root), [], "write with the start over question open");
    await button(m.root, "voice-over-confirm").click();
    await flush();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "some words for the scan";
    await type(box, box.value);
    await button(m.root, "voice-finish").click();
    await flush();
    assert.deepEqual(accessibilityProblems(m.root), [], "refine");
    const body = one(m.root, "[data-voice-polished-body]");
    body.value = "edited";
    await type(body, "edited");
    await button(m.root, "reset-to-rough").click();
    assert.deepEqual(accessibilityProblems(m.root), [], "refine with the reset question open");
    await button(m.root, "reset-cancel").click();
    await button(m.root, "save-polished").click();
    await flush();
    const stored = m.api.state.samples.find((s) => s.stage === "polished");
    stored.revision = "rev-elsewhere";
    body.value = "edited again";
    await type(body, "edited again");
    await button(m.root, "save-polished").click();
    await flush();
    assert.equal(one(m.root, "[data-voice-conflict]").hidden, false);
    assert.deepEqual(accessibilityProblems(m.root), [], "refine with the conflict question open");
  })();
});

test("the library and its empty state pass the accessibility scan", async () => {
  await withDom(async () => {
    const file = (over) => ({ valid: true, visibility: "private", words: 90, revision: "r", guidance: null, ...over });
    const data = {
      samples: [file({ id: "2026-10-20-a-rough", file: "2026-10-20-a-rough.md", stage: "rough", pack: "stories", prompt: "a", promptTitle: "A", title: "A", date: "2026-10-20T09:00:00Z" }), file({ valid: false, file: "2026-10-01-x-rough.md", guidance: "Repair it." })],
      coverage: [{ id: "stories", title: "Stories", summary: "S", total: 2, withRough: 1, withPolished: 0, prompts: [{ id: "a", title: "A", rough: true, polished: false }, { id: "b", title: "B", rough: false, polished: false }] }],
    };
    for (const payload of [data, { samples: [], coverage: data.coverage }]) {
      const library = createVoiceLibrary({ api: { async call() { return structuredClone(payload); } } });
      document.body.append(library.element);
      await library.load();
      await flush();
      assert.deepEqual(accessibilityProblems(library.element), []);
    }
  })();
});

test("the warning and the lock say what they mean in words and a shape, and a color is never the only signal", () => {
  const states = [timerLabel(120), timerLabel(30), timerLabel(0)];
  assert.deepEqual(states.map((s) => s.state), ["running", "warning", "locked"]);
  assert.equal(new Set(states.map((s) => s.symbol)).size, 3);
  assert.ok(states.every((s) => s.text.length > 3));
  // And the stylesheet gives each state a different border as well as a color.
  assert.match(css, /\.oba-voice-timer\[data-state="warning"\][^}]*border: 3px double/);
  assert.match(css, /\.oba-voice-timer\[data-state="locked"\][^}]*border: 3px solid/);
});

test("reduced motion is honoured: the only animation is behind no-preference and everything stops under reduce", () => {
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)\s*\{[^@]*oba-voice-pulse/);
  const reduce = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduce, /\.oba-voice \*/);
  assert.match(reduce, /animation: none/);
  assert.match(reduce, /transition: none/);
  // The animation name is only used inside the no-preference query.
  const uses = [...css.matchAll(/animation: oba-voice-pulse/g)].length;
  assert.equal(uses, 1);
  for (const forbidden of [/requestAnimationFrame/, /\.animate\(/, /behavior: ["']smooth["']/]) assert.doesNotMatch(source, forbidden);
});

test("a save that restates the clock between the marks never silences the thirty second mark", () => {
  let now = 0;
  const countdown = createCountdown(() => now);
  const announcer = createAnnouncer();
  countdown.sync(180);
  const heard = [];
  for (now = 0; now <= 180000; now += 250) {
    // The server rounds down, so an autosave reply between the marks moves the end a little sooner.
    if (now === 135750) countdown.sync(44);
    const message = announcer.update(countdown.remaining(), now);
    if (message) heard.push(message);
  }
  assert.deepEqual(heard, ["1 minute left.", "30 seconds left."]);
});
