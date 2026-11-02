import assert from "node:assert/strict";
import test from "node:test";

import { ROUGH_ATTRIBUTES, createVoiceSession } from "../../web/admin/voice-session.js";
import { ROUGH_NOTE, createCountdown, formatClock, spokenTime, timerLabel, timerState, wordCount } from "../../web/admin/voice.js";
import { choose, type, withDom } from "./dom-shim.mjs";
import { all, button, fakeClock, fakeServer, flush, link, one, text } from "./voice-harness.mjs";

// The Voice session (ADR 0272, #445): draw three prompts, write against the server's clock, lock, refine.
// The page is driven with a fake server that follows the real routes' rules and a clock the test moves.

let users = 0;
async function mount(options = {}) {
  const clock = fakeClock();
  const api = fakeServer(clock, options.server);
  api.state.listing = null;
  const session = createVoiceSession({ api, user: `writer-${++users}`, clock, params: options.params || new URLSearchParams(), onDirty: options.onDirty });
  document.body.append(session.element);
  await session.load();
  await flush();
  return { clock, api, session, root: session.element };
}

const radios = (root) => all(root, "input").filter((n) => n.attributes.type === "radio" && n.attributes.name?.endsWith("-prompt"));
async function startWriting(m, index = 0, visibility = null) {
  const choice = radios(m.root)[index];
  choice.checked = true;
  await choose(choice, choice.value);
  if (visibility) {
    const vis = all(m.root, "input").find((n) => n.attributes.type === "radio" && n.value === visibility);
    vis.checked = true;
    await choose(vis, visibility);
  }
  await button(m.root, "voice-start").click();
  await flush();
}
const rough = (root) => all(root, "textarea").find((n) => n.dataset.voiceRough === "true");
const clockText = (root) => text(one(root, "[data-voice-clock]"));

test("the pure helpers say the time in digits, in words, and in a shape as well as a color", () => {
  assert.equal(formatClock(180), "3:00");
  assert.equal(formatClock(59.2), "1:00");
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(-4), "0:00");
  assert.equal(spokenTime(60), "1 minute");
  assert.equal(spokenTime(30), "30 seconds");
  assert.equal(spokenTime(65), "1 minute 5 seconds");
  assert.equal(spokenTime(1), "1 second");
  assert.equal(wordCount("  two   words\nhere "), 3);
  assert.equal(timerState(31), "running");
  assert.equal(timerState(30), "warning");
  assert.equal(timerState(0), "locked");
  assert.equal(timerState(90, true), "locked");
  const shapes = new Set([timerLabel(100).symbol, timerLabel(10).symbol, timerLabel(0).symbol]);
  assert.equal(shapes.size, 3, "each state has its own shape");
  assert.match(timerLabel(10).text, /10 seconds left/);
  assert.equal(timerLabel(0).text, "Time is up");
});

test("the countdown follows the server's time left and never gives time back", () => {
  let now = 0;
  const countdown = createCountdown(() => now);
  assert.equal(countdown.remaining(), 0);
  countdown.sync(180);
  now = 1000;
  assert.equal(countdown.remaining(), 179);
  countdown.sync(100);
  assert.equal(countdown.remaining(), 100, "the server may move the end sooner");
  countdown.sync(500);
  assert.equal(countdown.remaining(), 100, "a later answer can not stretch it");
  now = 101000;
  assert.equal(countdown.remaining(), 0);
  assert.equal(countdown.expired(), true);
});

test("step one draws three prompts and starts only after one is chosen", async () => {
  await withDom(async () => {
    const m = await mount();
    const cards = all(m.root, "label").filter((n) => n.dataset.prompt);
    assert.equal(cards.length, 3);
    assert.match(text(cards[0]), /A mistake I made/);
    assert.match(text(cards[0]), /About 80 to 150 words/);
    assert.match(text(one(m.root, "[data-voice-rule]")), /the way you would say it/);
    const start = button(m.root, "voice-start");
    assert.equal(start.disabled, true);
    const first = radios(m.root)[0];
    first.checked = true;
    await choose(first, first.value);
    assert.equal(start.disabled, false);
    assert.equal(m.api.calls.filter((c) => c.path === "voice/session/start").length, 0, "nothing starts until asked");
  })();
});

test("Draw three more shows new prompts and asks the server to avoid the ones just shown", async () => {
  await withDom(async () => {
    const m = await mount();
    const before = radios(m.root).map((n) => n.value);
    await button(m.root, "voice-redraw").click();
    await flush();
    const after = radios(m.root).map((n) => n.value);
    assert.equal(after.length, 3);
    assert.ok(after.every((id) => !before.includes(id)), `${before} then ${after}`);
    assert.deepEqual(m.api.calls.at(-1).body.exclude, before);
    assert.equal(button(m.root, "voice-start").disabled, true, "a new draw needs a new choice");
    assert.match(text(one(m.root, "[data-voice-status]")), /new prompts/);
    assert.equal(document.activeElement, radios(m.root)[0], "focus lands on the first new prompt");
  })();
});

test("a pack in the address restricts the draw and says so", async () => {
  await withDom(async () => {
    const m = await mount({ params: new URLSearchParams("pack=opinions") });
    assert.deepEqual(m.api.calls.find((c) => c.path === "voice/draw").body, { pack: "opinions" });
    assert.ok(one(m.root, "[data-voice-pack]"));
    assert.deepEqual(radios(m.root).map((n) => n.value), ["my-hot-take"]);
  })();
});

test("starting is private by default and portable when chosen", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    assert.deepEqual(m.api.calls.find((c) => c.path === "voice/session/start").body, { promptId: "a-mistake-i-made", visibility: "private" });
  })();
  await withDom(async () => {
    const m = await mount();
    await startWriting(m, 1, "portable");
    assert.deepEqual(m.api.calls.find((c) => c.path === "voice/session/start").body, { promptId: "my-hot-take", visibility: "portable" });
  })();
});

test("step two shows the prompt, a 3:00 timer and a rough box that turns every correction off", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    assert.equal(clockText(m.root), "3:00");
    assert.equal(one(m.root, "[data-voice-timer]").dataset.state, "running");
    assert.match(text(m.root), /Tell about a mistake/);
    const box = rough(m.root);
    for (const [name, value] of Object.entries(ROUGH_ATTRIBUTES)) assert.equal(box.attributes[name], value, name);
    assert.equal(box.attributes.spellcheck, "false");
    assert.equal(box.attributes.autocorrect, "off");
    assert.equal(box.attributes.autocapitalize, "off");
    assert.equal(box.attributes.writingsuggestions, "false");
    assert.ok(!box.readOnly);
    const label = all(m.root, "label").find((l) => l.attributes.for === box.attributes.id);
    assert.equal(text(label), "Your rough draft");
    assert.ok(button(m.root, "voice-finish"));
    assert.equal(all(m.root, "textarea").length, 1, "only the rough box exists while writing");
  })();
});

test("the clock counts down, warns at thirty seconds in words and a shape, and locks at zero", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "teh quick brown fox";
    await type(box, "teh quick brown fox");
    await m.clock.advance(60000);
    assert.equal(clockText(m.root), "2:00");
    await m.clock.advance(89000);
    assert.equal(clockText(m.root), "0:31");
    assert.equal(one(m.root, "[data-voice-timer]").dataset.state, "running");
    await m.clock.advance(1000);
    assert.equal(clockText(m.root), "0:30");
    const timer = one(m.root, "[data-voice-timer]");
    assert.equal(timer.dataset.state, "warning");
    assert.match(text(one(m.root, "[data-voice-timer-state]")), /30 seconds left/);
    assert.ok(text(timer).includes("▲"));
    await m.clock.advance(30000);
    await flush();
    // The lock was asked for with the text on screen, and the page moved on to step three.
    const lock = m.api.calls.find((c) => c.path === "voice/session/lock");
    assert.equal(lock.body.text, "teh quick brown fox");
    assert.ok(one(m.root, "[data-voice-rough-view]"));
    assert.equal(all(m.root, "textarea").length, 1, "the only text area left is the polished one");
    assert.equal(m.api.state.samples[0].body, "teh quick brown fox");
  })();
});

test("Finish early locks at once and the rough draft is shown read-only with the reason", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "  Keep   my  spacing\n\nand my typos teh";
    await type(box, box.value);
    await button(m.root, "voice-finish").click();
    await flush();
    const view = one(m.root, "[data-voice-rough-text]");
    assert.equal(view.textContent, "  Keep   my  spacing\n\nand my typos teh");
    assert.equal(view.tagName, "DIV", "the locked text is not an editable control");
    assert.ok(!all(view, "textarea, input").length);
    assert.equal(rough(m.root), undefined, "no rough input remains");
    assert.match(text(one(m.root, "[data-voice-rough-view]")), new RegExp(ROUGH_NOTE.slice(0, 40)));
    assert.match(text(one(m.root, "[data-voice-locked]")), /saved exactly as you wrote it/);
    assert.match(text(one(m.root, "[data-voice-where]")), /Private/);
  })();
});

test("Finish early with nothing written explains and keeps the clock running", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    await button(m.root, "voice-finish").click();
    await flush();
    assert.match(text(one(m.root, "[data-voice-status]")), /Nothing is written yet/);
    assert.ok(!rough(m.root).readOnly);
    assert.equal(button(m.root, "voice-finish").disabled, false);
    assert.equal(document.activeElement, rough(m.root));
  })();
});

test("step three pre-fills the polished editor with the rough text and spell-check stays on there", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "my rough words";
    await type(box, "my rough words");
    await button(m.root, "voice-finish").click();
    await flush();
    const body = one(m.root, "[data-voice-polished-body]");
    const title = one(m.root, "[data-voice-polished-title]");
    assert.equal(body.value, "my rough words");
    assert.equal(title.value, "A mistake I made");
    assert.equal(body.attributes.spellcheck, undefined, "the author's own text keeps the browser's spell-check");
    assert.equal(body.attributes.autocorrect, undefined);
    assert.equal(button(m.root, "save-polished").disabled, false);
    assert.equal(document.activeElement, body);
  })();
});

test("Reset to rough puts the rough text back after asking, and Save writes the polished draft with its revision", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "original rough";
    await type(box, "original rough");
    await button(m.root, "voice-finish").click();
    await flush();
    const body = one(m.root, "[data-voice-polished-body]");
    const reset = button(m.root, "reset-to-rough");
    assert.equal(reset.disabled, true, "nothing to reset yet");
    body.value = "polished version";
    await type(body, "polished version");
    assert.equal(reset.disabled, false);
    await reset.click();
    assert.equal(body.value, "polished version", "asking first changes nothing");
    await button(m.root, "reset-cancel").click();
    assert.equal(body.value, "polished version");
    await reset.click();
    await button(m.root, "reset-confirm").click();
    assert.equal(body.value, "original rough");
    body.value = "polished version";
    await type(body, "polished version");
    await button(m.root, "save-polished").click();
    await flush();
    const created = m.api.calls.find((c) => c.method === "POST" && c.path === "voice/samples");
    assert.equal(created.body.roughOf, "2026-10-28-a-mistake-i-made-rough.md");
    assert.equal(created.body.body, "polished version");
    assert.match(text(one(m.root, "[data-voice-polished-status]")), /Saved\./);
    body.value = "polished again";
    await type(body, "polished again");
    await button(m.root, "save-polished").click();
    await flush();
    const update = m.api.calls.find((c) => c.method === "PUT" && c.path.startsWith("voice/samples/"));
    assert.ok(update.body.revision, "an update names the revision it was based on");
    assert.equal(m.api.state.samples.find((s) => s.stage === "rough").body, "original rough", "the rough draft never changed");
  })();
});

test("a polished save that finds a newer draft asks what to keep and loses nothing", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "rough text";
    await type(box, "rough text");
    await button(m.root, "voice-finish").click();
    await flush();
    const body = one(m.root, "[data-voice-polished-body]");
    body.value = "first save";
    await type(body, "first save");
    await button(m.root, "save-polished").click();
    await flush();
    // Another tab saves a newer one.
    const stored = m.api.state.samples.find((s) => s.stage === "polished");
    stored.body = "someone else's";
    stored.revision = "rev-other";
    body.value = "my later edit";
    await type(body, "my later edit");
    await button(m.root, "save-polished").click();
    await flush();
    assert.ok(!one(m.root, "[data-voice-conflict]").hidden);
    assert.equal(body.value, "my later edit", "the author's edit is still on screen");
    await button(m.root, "keep-mine").click();
    await flush();
    assert.equal(stored.body, "my later edit");
    assert.ok(one(m.root, "[data-voice-conflict]").hidden);
  })();
});

test("Start over asks first, then scraps the session and saves nothing", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    await button(m.root, "voice-over").click();
    assert.ok(!one(m.root, "[data-voice-scrap]").hidden);
    assert.equal(m.api.calls.filter((c) => c.method === "DELETE").length, 0);
    await button(m.root, "voice-over-confirm").click();
    await flush();
    assert.equal(m.api.state.session, null);
    assert.equal(m.api.state.samples.length, 0);
    assert.match(text(one(m.root, "[data-voice-notice]")), /Nothing was saved/);
  })();
});

test("a session that is already open can be continued or scrapped", async () => {
  await withDom(async () => {
    const m = await mount();
    // Another surface started one while this page showed the draw.
    m.api.state.session = { promptId: "my-hot-take", pack: "opinions", title: "My hot take", invitation: "Say it.", startedAt: "T0", deadlineMs: 180000, deadline: "D", draft: "kept words", visibility: "private" };
    await startWriting(m);
    const box = one(m.root, "[data-voice-open]");
    assert.match(text(box), /already open/);
    await button(m.root, "voice-continue").click();
    await flush();
    assert.equal(rough(m.root).value, "kept words", "continuing shows the saved draft");
  })();
  await withDom(async () => {
    const m = await mount();
    m.api.state.session = { promptId: "my-hot-take", pack: "opinions", title: "My hot take", invitation: "Say it.", startedAt: "T0", deadlineMs: 180000, deadline: "D", draft: "kept words", visibility: "private" };
    await startWriting(m);
    await button(m.root, "voice-scrap").click();
    await button(m.root, "voice-scrap-confirm").click();
    await flush();
    assert.equal(m.api.state.session, null);
  })();
  await withDom(async () => {
    const m = await mount();
    m.api.state.session = { promptId: "my-hot-take", pack: "opinions", title: "My hot take", invitation: "Say it.", startedAt: "T0", deadlineMs: 180000, deadline: "D", draft: "kept words", visibility: "private" };
    await startWriting(m);
    await button(m.root, "voice-scrap").click();
    assert.ok(document.activeElement === button(m.root, "voice-scrap-confirm"), "the question gets focus");
    // "No, keep it" hides the question it sits in; focus goes back to the button that asked it.
    await button(m.root, "voice-scrap-keep").click();
    assert.equal(button(m.root, "voice-scrap-confirm").parentNode?.hidden, true, "the question is hidden");
    assert.ok(document.activeElement === button(m.root, "voice-scrap"), "focus is back on Scrap it");
    assert.notEqual(m.api.state.session, null, "nothing was scrapped");
  })();
});

test("the draft is sent to the server a moment after typing stops, and the server's time left wins", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "some words";
    await type(box, "some words");
    assert.equal(m.api.calls.filter((c) => c.path === "voice/session/draft").length, 0, "not on every keystroke");
    await m.clock.advance(2000);
    const saves = m.api.calls.filter((c) => c.path === "voice/session/draft");
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body.text, "some words");
    assert.match(saves[0].body.sessionId, /^a-mistake-i-made@/);
    assert.equal(m.api.state.session.draft, "some words");
  })();
});

test("a draft refused as too late locks the rough draft instead of losing it", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    const box = rough(m.root);
    box.value = "typed before the end";
    await type(box, "typed before the end");
    // The page's clock is slow: the server's deadline passes first.
    m.api.state.session.deadlineMs = m.clock.now() + 1000;
    await m.clock.advance(1600);
    await flush();
    assert.ok(m.api.calls.some((c) => c.path === "voice/session/lock"), "the late save turned into a lock");
    assert.ok(one(m.root, "[data-voice-rough-view]"));
  })();
});

test("leaving for another view stops the clock", async () => {
  await withDom(async () => {
    const m = await mount();
    await startWriting(m);
    m.root.remove();
    await m.clock.advance(1000);
    assert.equal(m.clock.pending(), 0, "no timer is left running");
    await m.clock.advance(200000);
    assert.equal(m.api.calls.filter((c) => c.path === "voice/session/lock").length, 0, "a view that is gone does not lock");
  })();
});

test("a session found already locked on load shows the rough draft and the polished editor", async () => {
  await withDom(async () => {
    const m = await mount();
    m.api.state.session = { promptId: "my-hot-take", pack: "opinions", title: "My hot take", invitation: "Say it.", startedAt: "T0", deadlineMs: -1000, deadline: "D", draft: "saved before time ran out", visibility: "private" };
    await m.session.load();
    await flush();
    assert.match(text(one(m.root, "[data-voice-locked]")), /time ran out/);
    assert.equal(one(m.root, "[data-voice-rough-text]").textContent, "saved before time ran out");
    assert.ok(link(m.root, "voice-library"));
  })();
});
