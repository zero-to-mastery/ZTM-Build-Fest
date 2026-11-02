import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createPolishedEditor } from "../../web/admin/voice-polished.js";
import { createVoiceSession } from "../../web/admin/voice-session.js";
import { createPolishedDraftStore, polishedDirty } from "../../web/admin/voice.js";
import { choose, type, withDom } from "./dom-shim.mjs";
import { all, button, fakeClock, fakeServer, fakeStorage, flush, one, text } from "./voice-harness.mjs";

// The unsaved guard for polished edits (ADR 0273, #447). Admin's own guard asks `viewDirty()` before it leaves a
// view; the Voice view answers with the polished editor's state. A rough draft is saved on the server as it is
// written and locked at the end, so it never counts as unsaved work.

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
let users = 0;

function roughSample() {
  return { id: "2026-10-28-a-mistake-i-made-rough", file: "2026-10-28-a-mistake-i-made-rough.md", visibility: "private", stage: "rough", pack: "stories", prompt: "a-mistake-i-made", promptTitle: "A mistake I made", title: "A mistake I made", words: 3, date: "2026-10-28T09:00:00Z", body: "my rough words", valid: true, revision: "rev-rough", roughOf: null };
}

function editorOn({ storage = fakeStorage(), polished = null, server } = {}) {
  const clock = fakeClock();
  const api = server || fakeServer(clock);
  if (!api.state.samples.length) api.state.samples.push(roughSample());
  const changes = [];
  const user = `guard-${++users}`;
  const make = (extra = {}) => {
    const editor = createPolishedEditor({
      api,
      user,
      storage: () => storage,
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
      rough: { file: roughSample().file, title: "A mistake I made", body: "my rough words" },
      polished,
      onChange: (dirty) => changes.push(dirty),
      ...extra,
    });
    document.body.append(editor.element);
    return editor;
  };
  return { clock, api, storage, changes, make, user };
}
const body = (editor) => one(editor.element, "[data-voice-polished-body]");
const typeBody = async (editor, value) => {
  body(editor).value = value;
  await type(body(editor), value);
};

test("the guard compares the polished text with the saved state, not with whether anything was typed", () => {
  const saved = { title: "T", body: "B" };
  assert.equal(polishedDirty({ title: "T", body: "B" }, saved), false);
  assert.equal(polishedDirty({ title: "T2", body: "B" }, saved), true);
  assert.equal(polishedDirty({ title: "T", body: "B " }, saved), true);
});

test("Admin asks the Voice view whether it has unsaved work, and the view answers with the polished editor", () => {
  const shown = admin.slice(admin.indexOf("async showVoice("), admin.indexOf("// ---- customize look"));
  assert.match(shown, /this\.viewDirty = \(\) => view\.isDirty\(\)/);
  assert.match(shown, /this\.viewBusy = \(\) => view\.isBusy\(\)/);
});

test("a pre-filled polished editor is not unsaved work; an edit is; undoing the edit is not", async () => {
  await withDom(async () => {
    const t = editorOn();
    const editor = t.make();
    assert.equal(editor.isDirty(), false, "the starting copy of the rough text is not a change");
    assert.match(text(one(editor.element, ".oba-voice-dirty")), /Not saved yet/);
    await typeBody(editor, "my rough words, polished");
    assert.equal(editor.isDirty(), true);
    assert.deepEqual(t.changes, [true]);
    assert.match(text(one(editor.element, ".oba-voice-dirty")), /You have unsaved changes/);
    await typeBody(editor, "my rough words");
    assert.equal(editor.isDirty(), false);
    assert.deepEqual(t.changes, [true, false]);
  })();
});

test("saving makes the editor clean again, and the next edit makes it dirty against the saved text", async () => {
  await withDom(async () => {
    const t = editorOn();
    const editor = t.make();
    await typeBody(editor, "first polish");
    await button(editor.element, "save-polished").click();
    await flush();
    assert.equal(editor.isDirty(), false);
    assert.match(text(one(editor.element, ".oba-voice-dirty")), /All changes saved/);
    await typeBody(editor, "first polish");
    assert.equal(editor.isDirty(), false, "the same text as saved is not a change");
    await typeBody(editor, "second polish");
    assert.equal(editor.isDirty(), true);
  })();
});

test("edits typed while a save is in flight stay unsaved and are not overwritten by the answer", async () => {
  await withDom(async () => {
    const t = editorOn();
    const editor = t.make();
    let release;
    t.api.state.holds.push({ method: "POST", path: "voice/samples", promise: new Promise((done) => { release = done; }) });
    await typeBody(editor, "sent text");
    const saving = button(editor.element, "save-polished").click();
    await flush();
    assert.equal(editor.isBusy(), true);
    assert.equal(button(editor.element, "save-polished").disabled, true);
    await typeBody(editor, "sent text and more typed during the save");
    release();
    await saving;
    await flush();
    assert.equal(body(editor).value, "sent text and more typed during the save", "the author's later typing is kept");
    assert.equal(editor.isDirty(), true, "and it is still unsaved");
    assert.match(text(one(editor.element, "[data-voice-polished-status]")), /still unsaved/);
    assert.equal(editor.isBusy(), false);
  })();
});

test("the rough step never counts as unsaved work", async () => {
  await withDom(async () => {
    const clock = fakeClock();
    const api = fakeServer(clock);
    const dirty = [];
    const session = createVoiceSession({ api, user: `guard-${++users}`, clock, storage: () => fakeStorage(), onDirty: (d) => dirty.push(d) });
    document.body.append(session.element);
    await session.load();
    await flush();
    const first = all(session.element, "input").find((n) => n.attributes.type === "radio" && n.attributes.name?.endsWith("-prompt"));
    first.checked = true;
    await choose(first, first.value);
    await button(session.element, "voice-start").click();
    await flush();
    const rough = all(session.element, "textarea")[0];
    rough.value = "words not yet autosaved";
    await type(rough, rough.value);
    assert.equal(session.isDirty(), false, "the draft is autosaved and locked at the end");
    assert.deepEqual(dirty, []);
    await button(session.element, "voice-finish").click();
    await flush();
    assert.equal(session.isDirty(), false);
    const polished = one(session.element, "[data-voice-polished-body]");
    polished.value = "edited";
    await type(polished, "edited");
    assert.equal(session.isDirty(), true);
    assert.deepEqual(dirty, [true]);
    assert.equal(session.isBusy(), false);
  })();
});

test("Start another session will not discard unsaved polished work", async () => {
  await withDom(async () => {
    const clock = fakeClock();
    const api = fakeServer(clock);
    const session = createVoiceSession({ api, user: `guard-${++users}`, clock, storage: () => fakeStorage() });
    document.body.append(session.element);
    await session.load();
    await flush();
    const first = all(session.element, "input").find((n) => n.attributes.type === "radio" && n.attributes.name?.endsWith("-prompt"));
    first.checked = true;
    await choose(first, first.value);
    await button(session.element, "voice-start").click();
    await flush();
    const rough = all(session.element, "textarea")[0];
    rough.value = "some words";
    await type(rough, rough.value);
    await button(session.element, "voice-finish").click();
    await flush();
    const polished = one(session.element, "[data-voice-polished-body]");
    polished.value = "edited and unsaved";
    await type(polished, polished.value);
    await button(session.element, "voice-another").click();
    await flush();
    assert.ok(one(session.element, "[data-voice-polished]"), "still on the polished editor");
    assert.match(text(one(session.element, "[data-voice-move-status]")), /unsaved changes/);
    assert.equal(polished.value, "edited and unsaved");
  })();
});

test("unsaved polished edits are kept on the device and offered back, never applied unasked", async () => {
  await withDom(async () => {
    const t = editorOn();
    const first = t.make();
    await typeBody(first, "an unsaved polish");
    await t.clock.advance(400);
    const store = createPolishedDraftStore(`ob-voice-polished:${t.user}:2026-10-28-a-mistake-i-made-rough.md`, () => t.storage);
    assert.equal(store.load().body, "an unsaved polish");
    assert.equal(store.load().base, null);
    // The page is reloaded: a new editor on the same rough draft.
    document.body.replaceChildren();
    const again = t.make();
    assert.equal(body(again).value, "my rough words", "nothing is applied unasked");
    assert.equal(again.isDirty(), false);
    const box = one(again.element, "[data-voice-restore]");
    assert.equal(box.hidden, false);
    await button(again.element, "restore-draft").click();
    assert.equal(body(again).value, "an unsaved polish");
    assert.equal(again.isDirty(), true);
    assert.equal(box.hidden, true);
  })();
});

test("Discard throws the kept copy away, and saving clears it", async () => {
  await withDom(async () => {
    const t = editorOn();
    const first = t.make();
    await typeBody(first, "to discard");
    await t.clock.advance(400);
    document.body.replaceChildren();
    const again = t.make();
    await button(again.element, "discard-draft").click();
    assert.equal(body(again).value, "my rough words");
    assert.equal(t.storage.values.size, 0);
    await typeBody(again, "to save");
    await t.clock.advance(400);
    assert.equal(t.storage.values.size, 1);
    await button(again.element, "save-polished").click();
    await flush();
    assert.equal(t.storage.values.size, 0, "a saved draft leaves no copy");
  })();
});

test("a copy made on top of an older saved draft is checked against that draft, so a change elsewhere is a choice", async () => {
  await withDom(async () => {
    const clock = fakeClock();
    const server = fakeServer(clock);
    server.state.samples.push(roughSample());
    const storage = fakeStorage();
    const t = editorOn({ storage, server });
    const first = t.make();
    await typeBody(first, "version one");
    await button(first.element, "save-polished").click();
    await flush();
    const saved = server.state.samples.find((s) => s.stage === "polished");
    await typeBody(first, "version two, unsaved");
    await t.clock.advance(400);
    // Someone else saves a newer one before this page comes back.
    saved.body = "someone else's version";
    saved.revision = "rev-elsewhere";
    document.body.replaceChildren();
    const again = t.make({ polished: { ...saved } });
    assert.match(text(one(again.element, "[data-voice-restore]")), /has changed since/);
    await button(again.element, "restore-draft").click();
    await button(again.element, "save-polished").click();
    await flush();
    assert.equal(one(again.element, "[data-voice-conflict]").hidden, false, "saving asks instead of overwriting");
    assert.equal(saved.body, "someone else's version");
    await button(again.element, "keep-editing").click();
    assert.equal(body(again).value, "version two, unsaved");
  })();
});

test("with storage that refuses, the editor says the edits are held only in this page", async () => {
  await withDom(async () => {
    const t = editorOn({ storage: fakeStorage({ blocked: true }) });
    const editor = t.make();
    await typeBody(editor, "no storage");
    await t.clock.advance(400);
    assert.match(text(one(editor.element, ".oba-voice-dirty")), /would not keep a copy/);
    assert.equal(editor.isDirty(), true);
  })();
});

test("a draft that would not fit a sample is not kept on the device", () => {
  const store = createPolishedDraftStore("big-polished", () => fakeStorage());
  assert.equal(store.save({ base: null, title: "t", body: "x".repeat(60 * 1024 + 1) }), false);
  assert.equal(store.save({ base: "r", title: "t", body: "fits" }), true);
});

test("the action bar's observers and listeners are removed once its view is gone", async () => {
  const { keepBarReachable } = await import("../../web/admin/voice-polished.js");
  const added = new Map();
  const real = { add: globalThis.addEventListener, remove: globalThis.removeEventListener, observer: globalThis.ResizeObserver, height: globalThis.innerHeight };
  let disconnected = 0;
  globalThis.addEventListener = (name, fn) => added.set(name, fn);
  globalThis.removeEventListener = (name, fn) => {
    if (added.get(name) === fn) added.delete(name);
  };
  globalThis.innerHeight = 800;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {
      disconnected += 1;
    }
  };
  try {
    let current = true;
    const bar = { getBoundingClientRect: () => ({ height: 10 }), classList: { toggle() {} }, style: {} };
    const settle = keepBarReachable(bar, () => current);
    assert.equal(added.has("resize"), true);
    current = false;
    settle();
    assert.equal(added.has("resize"), false, "the window listener is gone");
    assert.equal(disconnected, 1, "the observer is disconnected");
    // An explicit stop is safe to repeat.
    settle.stop();
  } finally {
    globalThis.addEventListener = real.add;
    globalThis.removeEventListener = real.remove;
    globalThis.ResizeObserver = real.observer;
    globalThis.innerHeight = real.height;
  }
});
