import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceLibrary } from "../../web/admin/voice-library.js";
import { ApiError, type as typeInto, withDom } from "./dom-shim.mjs";
import { button, flush, one, text } from "./voice-harness.mjs";

// Erase everything (#465): the list comes first, the typed word is needed, one request does it all, and the
// result says whether a second look found anything left.

const items = [
  { path: "assistant/context/voice/2026-10-28-a-rough.md", kind: "sample" },
  { path: ".openblog/private/voice/session.json", kind: "session record" },
];

function server(over = {}) {
  const calls = [];
  return {
    calls,
    async call(method, path, options) {
      calls.push({ method, path, body: options?.json });
      if (method === "GET" && path === "voice/samples") return { samples: [], coverage: [], warnings: [] };
      if (method === "GET" && path === "voice/erase") return over.plan ?? { items, confirm: "erase" };
      if (method === "POST" && path === "voice/erase") {
        if (over.fail) throw new ApiError(500, { error: "Cannot erase one file. Nothing was erased." });
        return over.done ?? { erased: items, remaining: [], clean: true };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

async function mount(api) {
  const library = createVoiceLibrary({ api });
  document.body.append(library.element);
  await library.load();
  await flush();
  return library.element;
}

const press = async (node) => {
  await node.click();
  await flush();
};
const type = async (input, value) => {
  await typeInto(input, value);
  await flush();
};
const start = (root) => button(root, "voice-erase-start");
const confirmButton = (root) => button(root, "voice-erase-confirm");

test("nothing is requested until the author asks, and the list is shown before the confirmation", async () => {
  await withDom(async () => {
    const api = server();
    const root = await mount(api);
    assert.deepEqual(api.calls.map((c) => c.method + " " + c.path), ["GET voice/samples"]);
    await press(start(root));
    assert.equal(api.calls.at(-1).path, "voice/erase");
    const list = text(one(root, "[data-voice-erase-list]"));
    assert.ok(list.includes("session.json") && list.includes("a-rough.md"));
    const confirm = confirmButton(root);
    assert.equal(confirm.disabled, true, "disabled until the word is typed");
    assert.ok(one(root, "label[for]"), "the field is labelled");
  })();
});

test("the typed word enables the erase, one request carries it, and a clean check is said", async () => {
  await withDom(async () => {
    const api = server();
    const root = await mount(api);
    await press(start(root));
    const input = one(root, "[data-voice-erase-word]");
    const confirm = confirmButton(root);
    await type(input, "nope");
    assert.equal(confirm.disabled, true);
    await type(input, "Erase");
    assert.equal(confirm.disabled, false);
    await press(confirm);
    const posts = api.calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { confirm: "Erase" });
    assert.match(text(one(root, "[data-voice-erase-status]")), /Erased 2 files\. Checked again: nothing is left/);
    assert.equal(one(root, "[data-voice-erase-list]"), null);
  })();
});

test("a failure says nothing was erased and keeps the confirmation open", async () => {
  await withDom(async () => {
    const root = await mount(server({ fail: true }));
    await press(start(root));
    await type(one(root, "[data-voice-erase-word]"), "erase");
    await press(confirmButton(root));
    assert.match(text(one(root, "[data-voice-erase-status]")), /Nothing was erased/);
    assert.ok(one(root, "[data-voice-erase-list]"));
  })();
});

test("leftovers found by the post-check are named, and an empty plan erases nothing", async () => {
  await withDom(async () => {
    const root = await mount(server({ done: { erased: items, remaining: ["assistant/context/voice"], clean: false } }));
    await press(start(root));
    await type(one(root, "[data-voice-erase-word]"), "erase");
    await press(confirmButton(root));
    assert.match(text(one(root, "[data-voice-erase-status]")), /still there: assistant\/context\/voice/);
  })();
  await withDom(async () => {
    const api = server({ plan: { items: [], confirm: "erase" } });
    const root = await mount(api);
    await press(start(root));
    assert.match(text(one(root, "[data-voice-erase-status]")), /no voice data/);
    assert.equal(api.calls.filter((c) => c.method === "POST").length, 0);
  })();
});

test("after a clean erase the list is drawn again without the erased samples, and focus goes to the result", async () => {
  await withDom(async () => {
    let erased = false;
    const sample = { id: "2026-10-28-a-rough", file: "2026-10-28-a-rough.md", valid: true, stage: "rough", pack: "stories", prompt: "a", promptTitle: "A", title: "A", date: "2026-10-28T09:00:00Z", words: 3, visibility: "private", roughOf: null };
    const coverage = [{ id: "stories", title: "Stories", summary: "", total: 1, withRough: 1, withPolished: 0, prompts: [{ id: "a", title: "A", rough: true, polished: false }] }];
    const api = {
      async call(method, path) {
        if (method === "GET" && path === "voice/samples") return erased ? { samples: [], coverage, warnings: [] } : { samples: [sample], coverage, warnings: [] };
        if (method === "GET" && path === "voice/erase") return { items, confirm: "erase" };
        if (method === "POST" && path === "voice/erase") {
          erased = true;
          return { erased: items, remaining: [], clean: true };
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    };
    const root = await mount(api);
    assert.match(text(root), /Read rough draft/);
    await press(start(root));
    await type(one(root, "[data-voice-erase-word]"), "erase");
    await press(confirmButton(root));
    await flush();
    assert.doesNotMatch(text(root), /Read rough draft/, "no link to an erased sample is left");
    assert.ok(one(root, "[data-voice-empty]"));
    const status = one(root, "[data-voice-erase-status]");
    assert.match(text(status), /nothing is left/);
    assert.equal(document.activeElement, status);
  })();
});

test("keeping the data puts focus back on the button that started the erase", async () => {
  await withDom(async () => {
    const root = await mount(server());
    await press(start(root));
    await press(button(root, "voice-erase-cancel"));
    assert.equal(document.activeElement, start(root));
  })();
});
