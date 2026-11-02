import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceLibrary } from "../../web/admin/voice-library.js";
import { ROUGH_NOTE, libraryHash } from "../../web/admin/voice.js";
import { ApiError, type, withDom } from "./dom-shim.mjs";
import { accessibilityProblems, all, button, fakeClock, fakeServer, fakeStorage, flush, link, one, text } from "./voice-harness.mjs";

// Open and edit from the library (ADR 0274, #449): a rough sample opens read-only with the reason, a polished one
// opens editable with revision checks, and either stage opens with both drafts. A saved polished draft can become a post draft.

const ROUGH = { id: "2026-10-22-a-mistake-i-made-rough", file: "2026-10-22-a-mistake-i-made-rough.md", visibility: "private", stage: "rough", pack: "stories", prompt: "a-mistake-i-made", promptTitle: "A mistake I made", title: "A mistake I made", words: 5, date: "2026-10-22T09:00:00Z", body: "teh rough words, as typed", valid: true, revision: "rev-rough", roughOf: null };
const POLISHED = { ...ROUGH, id: "2026-10-22-a-mistake-i-made-polished", file: "2026-10-22-a-mistake-i-made-polished.md", stage: "polished", roughOf: ROUGH.file, title: "My polished title", body: "The polished words.", words: 3, revision: "rev-polished" };

let users = 0;
async function open(id, { samples = [ROUGH, POLISHED], storage = fakeStorage() } = {}) {
  const clock = fakeClock();
  const api = fakeServer(clock);
  api.state.samples.push(...structuredClone(samples));
  const dirty = [];
  const library = createVoiceLibrary({ api, user: `open-${++users}`, storage: () => storage, clock, onDirty: (d) => dirty.push(d) });
  document.body.append(library.element);
  await library.load(id);
  await flush();
  return { api, clock, library, root: library.element, dirty, storage };
}
const body = (root) => one(root, "[data-voice-polished-body]");
const titleField = (root) => one(root, "[data-voice-polished-title]");
const typeInto = async (node, value) => {
  node.value = value;
  await type(node, value);
};

test("a rough sample opens read-only with a sentence on why, and its view has no editable control", async () => {
  await withDom(async () => {
    const m = await open(ROUGH.id, { samples: [ROUGH] });
    const view = one(m.root, "[data-voice-rough-view]");
    assert.equal(one(view, "[data-voice-rough-text]").textContent, "teh rough words, as typed");
    assert.equal(text(one(view, "[data-voice-rough-note]")), ROUGH_NOTE);
    assert.match(ROUGH_NOTE, /exactly as you wrote it/);
    assert.equal(all(view, "textarea").length, 0);
    assert.equal(all(view, "input").length, 0);
    assert.equal(all(view, "select").length, 0);
    assert.equal(all(view, "*").filter((n) => n.attributes.contenteditable !== undefined).length, 0);
    assert.equal(one(view, "[data-voice-rough-text]").tagName, "DIV");
    // The only control in the rough view moves the pair; it does not touch the words.
    assert.deepEqual(all(view, "button").map((b) => b.dataset.action), ["voice-move"]);
    assert.equal(text(one(m.root, "h2")), "A mistake I made");
    assert.equal(document.activeElement, one(m.root, "h2"), "a rough sample opens at its heading");
  })();
});

test("a rough sample with no polished draft offers to polish a copy, pre-filled, and opening changes nothing", async () => {
  await withDom(async () => {
    const m = await open(ROUGH.id, { samples: [ROUGH] });
    assert.equal(text(one(m.root, "[data-voice-polish-heading]")), "Polish a copy");
    assert.equal(body(m.root).value, "teh rough words, as typed");
    assert.equal(titleField(m.root).value, "A mistake I made");
    assert.equal(m.library.isDirty(), false, "a copy nobody edited is not unsaved work");
    assert.deepEqual(m.api.calls.map((c) => `${c.method} ${c.path}`), ["GET voice/samples/2026-10-22-a-mistake-i-made-rough"]);
    await typeInto(body(m.root), "Polished.");
    assert.equal(m.library.isDirty(), true);
    await button(m.root, "save-polished").click();
    await flush();
    const write = m.api.calls.at(-1);
    assert.equal(`${write.method} ${write.path}`, "POST voice/samples", "a new polished draft is created, never a rough one changed");
    assert.equal(write.body.roughOf, ROUGH.file);
    assert.equal(m.api.state.samples.find((s) => s.stage === "rough").body, "teh rough words, as typed");
    assert.equal(m.library.isDirty(), false);
  })();
});

test("no call from the rough view or its editor ever writes to the rough draft", async () => {
  await withDom(async () => {
    const m = await open(ROUGH.id, { samples: [ROUGH] });
    await typeInto(body(m.root), "changed");
    await button(m.root, "save-polished").click();
    await flush();
    await typeInto(body(m.root), "changed again");
    await button(m.root, "save-polished").click();
    await flush();
    for (const call of m.api.calls) assert.ok(!(call.method === "PUT" && call.path.includes("rough")), `${call.method} ${call.path}`);
    assert.equal(m.api.state.samples.find((s) => s.stage === "rough").revision, "rev-rough");
  })();
});

test("a polished sample opens editable with its revision, beside its rough draft, and saves with that revision", async () => {
  await withDom(async () => {
    const m = await open(POLISHED.id);
    assert.equal(text(one(m.root, "[data-voice-polish-heading]")), "Edit your polished draft");
    assert.equal(body(m.root).value, "The polished words.");
    assert.equal(titleField(m.root).value, "My polished title");
    assert.equal(one(m.root, "[data-voice-rough-text]").textContent, "teh rough words, as typed", "the rough draft is shown, read-only, beside it");
    assert.equal(document.activeElement, body(m.root), "a polished sample opens in its editor");
    assert.equal(m.library.isDirty(), false);
    await typeInto(body(m.root), "The polished words, polished again.");
    assert.equal(m.library.isDirty(), true);
    assert.deepEqual(m.dirty, [true]);
    await button(m.root, "save-polished").click();
    await flush();
    const write = m.api.calls.at(-1);
    assert.equal(`${write.method} ${write.path}`, `PUT voice/samples/${POLISHED.id}`);
    assert.equal(write.body.revision, "rev-polished");
    assert.equal(write.body.body, "The polished words, polished again.");
    assert.equal(m.library.isDirty(), false);
    assert.equal(m.api.state.samples.find((s) => s.stage === "rough").body, "teh rough words, as typed");
  })();
});

test("a polished save that finds a newer draft asks what to keep, as in the session", async () => {
  await withDom(async () => {
    const m = await open(POLISHED.id);
    const stored = m.api.state.samples.find((s) => s.stage === "polished");
    stored.revision = "rev-other-tab";
    stored.body = "saved from another tab";
    await typeInto(body(m.root), "my edit");
    await button(m.root, "save-polished").click();
    await flush();
    assert.equal(one(m.root, "[data-voice-conflict]").hidden, false);
    assert.equal(stored.body, "saved from another tab", "nothing was overwritten");
    await button(m.root, "use-saved").click();
    assert.equal(body(m.root).value, "saved from another tab");
    assert.equal(m.library.isDirty(), false);
  })();
});

test("Reset to rough on an opened polished draft brings the rough text back after asking", async () => {
  await withDom(async () => {
    const m = await open(POLISHED.id);
    await button(m.root, "reset-to-rough").click();
    await button(m.root, "reset-confirm").click();
    assert.equal(body(m.root).value, "teh rough words, as typed");
    assert.equal(titleField(m.root).value, "A mistake I made");
    assert.equal(m.library.isDirty(), true, "it is an edit until it is saved");
  })();
});

test("the pair can be moved from the open view, and the rough view says where it is kept", async () => {
  await withDom(async () => {
    const m = await open(ROUGH.id);
    assert.match(text(one(m.root, "[data-voice-where]")), /Private/);
    await button(m.root, "voice-move").click();
    await flush();
    const call = m.api.calls.find((c) => c.path.endsWith("/visibility"));
    assert.deepEqual(call.body, { visibility: "portable" });
    assert.match(text(one(m.root, "[data-voice-where]")), /Portable/);
    assert.match(text(one(m.root, "[data-voice-move-status]")), /byte for byte/);
  })();
});

test("a sample that is not there, or cannot be read, says so and offers the way back", async () => {
  await withDom(async () => {
    const m = await open("2020-01-01-nothing-rough", { samples: [] });
    assert.match(text(one(m.root, "[data-voice-error]")), /no such voice sample/);
    assert.equal(link(m.root, "voice-back").attributes.href, libraryHash());
    assert.equal(all(m.root, "textarea").length, 0);
  })();
  await withDom(async () => {
    const broken = { ...ROUGH, valid: false, guidance: "The field `voice.stage` is missing. Repair the file in a text editor, or erase it here.", body: null };
    const m = await open(ROUGH.id, { samples: [broken] });
    assert.match(text(one(m.root, "[data-voice-invalid-file]")), /voice\.stage/);
    assert.equal(all(m.root, "textarea").length, 0, "an unreadable file has no editor");
    assert.equal(all(m.root, "button").length, 0);
  })();
  await withDom(async () => {
    const m = await open(POLISHED.id, { samples: [POLISHED] });
    // Its rough draft is not in the folder: the server's listing already calls that invalid, and the open view agrees.
    assert.ok(one(m.root, "[data-voice-invalid-file]") || one(m.root, "[data-voice-error]"));
    assert.equal(all(m.root, "textarea").length, 0);
  })();
});

test("a failed open says so in words", async () => {
  await withDom(async () => {
    const clock = fakeClock();
    const api = fakeServer(clock);
    api.state.failures.push({ method: "GET", path: "voice/samples/x", error: new ApiError("down", 500, null) });
    const library = createVoiceLibrary({ api, user: "u", storage: () => fakeStorage(), clock });
    document.body.append(library.element);
    await library.load("x");
    await flush();
    assert.match(text(one(library.element, "[data-voice-error]")), /server could not do that/);
  })();
});

test("each library row links to the sample its stage allows: read rough, edit polished, or polish this", async () => {
  await withDom(async () => {
    const file = (over) => ({ valid: true, visibility: "private", words: 50, revision: "r", guidance: null, ...over });
    const listing = {
      samples: [
        file({ id: "2026-10-22-a-rough", file: "2026-10-22-a-rough.md", stage: "rough", pack: "stories", prompt: "a", promptTitle: "A", title: "A", date: "2026-10-22T09:00:00Z" }),
        file({ id: "2026-10-22-a-polished", file: "2026-10-22-a-polished.md", stage: "polished", pack: "stories", prompt: "a", promptTitle: "A", title: "A", date: "2026-10-22T09:00:00Z", roughOf: "2026-10-22-a-rough.md" }),
        file({ id: "2026-10-21-b-rough", file: "2026-10-21-b-rough.md", stage: "rough", pack: "stories", prompt: "b", promptTitle: "B", title: "B", date: "2026-10-21T09:00:00Z" }),
      ],
      coverage: [{ id: "stories", title: "Stories", summary: "", total: 2, withRough: 2, withPolished: 1, prompts: [{ id: "a", title: "A", rough: true, polished: true }, { id: "b", title: "B", rough: true, polished: false }] }],
    };
    const library = createVoiceLibrary({ api: { async call() { return structuredClone(listing); } } });
    document.body.append(library.element);
    await library.load();
    await flush();
    const rowA = all(library.element, "li").find((n) => n.dataset.prompt === "a");
    const rowB = all(library.element, "li").find((n) => n.dataset.prompt === "b");
    assert.equal(link(rowA, "voice-open-rough").attributes.href, "#/voice/library/2026-10-22-a-rough");
    assert.equal(link(rowA, "voice-open-polished").attributes.href, "#/voice/library/2026-10-22-a-polished");
    assert.equal(link(rowA, "voice-polish"), null);
    assert.equal(link(rowB, "voice-open-rough").attributes.href, "#/voice/library/2026-10-21-b-rough");
    assert.equal(link(rowB, "voice-polish").attributes.href, "#/voice/library/2026-10-21-b-rough");
    assert.equal(link(rowB, "voice-open-polished"), null);
    assert.match(link(rowA, "voice-open-polished").attributes["aria-label"], /polished draft: A/);
    assert.deepEqual(accessibilityProblems(library.element), []);
  })();
});

test("the opened views pass the accessibility scan", async () => {
  await withDom(async () => {
    for (const id of [ROUGH.id, POLISHED.id]) {
      const m = await open(id);
      assert.deepEqual(accessibilityProblems(m.root), [], id);
      await typeInto(body(m.root), "edited");
      await button(m.root, "reset-to-rough").click();
      assert.deepEqual(accessibilityProblems(m.root), [], `${id} with the reset question open`);
      document.body.replaceChildren();
    }
  })();
});

test("a saved polished draft can be made a post draft and links to it in Write; a rough sample has no such button", async () => {
  await withDom(async () => {
    const rough = await open(ROUGH.id, { samples: [ROUGH] });
    assert.equal(all(rough.root, "[data-action=voice-promote]").length, 0);
    const m = await open(POLISHED.id);
    await typeInto(body(m.root), "Edited but not saved.");
    await button(m.root, "voice-promote").click();
    await flush();
    assert.equal(m.api.calls.some((c) => c.path.endsWith("/promote")), false, "unsaved edits are not promoted");
    assert.match(text(one(m.root, "[data-voice-promote-status]")), /Save your polished draft first/);
    await typeInto(body(m.root), POLISHED.body);
    await button(m.root, "voice-promote").click();
    await flush();
    const call = m.api.calls.find((c) => c.path.endsWith("/promote"));
    assert.equal(call.path, `voice/samples/${POLISHED.id}/promote`);
    assert.equal(link(m.root, "voice-open-post").attributes.href, "#/edit/posts%2Fmy-polished-title.md");
  })();
});

test("a taken slug is said in words and the button works again", async () => {
  await withDom(async () => {
    const m = await open(POLISHED.id);
    m.api.state.promoteTaken = true;
    await button(m.root, "voice-promote").click();
    await flush();
    assert.match(text(one(m.root, "[data-voice-promote-status]")), /already uses the slug/);
    assert.equal(button(m.root, "voice-promote").disabled, false);
  })();
});

test("the editor has one heading a level under the sample's, and a first save offers Make a post draft", async () => {
  await withDom(async () => {
    const m = await open(ROUGH.id, { samples: [ROUGH] });
    const headings = all(m.root, "h2,h3,h4").map((h) => `${h.tagName}:${text(h)}`);
    assert.deepEqual(headings.filter((h) => /polish/i.test(h)), ["H3:Polish a copy"]);
    assert.equal(all(m.root, "h2").length, 1, "only the sample's own heading is an h2");
    assert.equal(button(m.root, "voice-promote"), null);
    await typeInto(body(m.root), "Polished.");
    await button(m.root, "save-polished").click();
    await flush();
    assert.ok(button(m.root, "voice-promote"), "Make a post draft appears once the polished draft exists");
  })();
});
