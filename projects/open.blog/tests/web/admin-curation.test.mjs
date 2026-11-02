import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CURATION_KINDS,
  CURATION_WHY,
  createBoundaryPreview,
  createCurationSection,
  createDraftResearchPanel,
  curationItemRows,
  curationMove,
  curationPostSlug,
  curationSelectionName,
  curationStatusText,
  curationValueText,
} from "../../web/admin/admin.js";
import { ApiError, tick, withDom } from "./dom-shim.mjs";

// Selected for readers (#196, ADR 0195, ADR 0196): the author's view of the selections inside the
// draft-side research panel. The view is the shared fixture the Rust tests pin byte for byte
// (tests/fixtures/curated-selections/view.json), so the page is tested against exactly what the
// server sends: what readers get, what is withheld and why, notices, ordering, and the forms that
// select, withdraw, select again and unselect, with revision checks, failures that change nothing,
// and focus that stays where the author is.

const FIXTURE = readFileSync(new URL("../fixtures/curated-selections/view.json", import.meta.url), "utf8");
const view = () => JSON.parse(FIXTURE);
const PRIVATE = "PRIVATE-CURATION-MARKER";

/** A fake server: every call is recorded; `answer` decides the reply to a change. */
function server(initial = view(), answer = () => null) {
  const calls = [];
  const state = { view: initial };
  return {
    calls,
    state,
    async call(method, path, options = {}) {
      const body = options.json === undefined ? undefined : structuredClone(options.json);
      calls.push({ method, path, body });
      if (method === "GET" && path.startsWith("research/curation")) return structuredClone(state.view);
      const reply = answer(method, path, body, state);
      if (reply instanceof Error) throw reply;
      if (reply) return structuredClone(reply);
      throw new ApiError(`unexpected ${method} ${path}`, 500, null);
    },
  };
}

async function mount(api, post = "cave", options = {}) {
  const section = createCurationSection({ api, getPost: () => post, ...options });
  document.body.append(section.element);
  await section.load();
  return { section, root: section.element, api };
}

const all = (root, tag) => root.querySelectorAll(tag);
const named = (root, text) => all(root, "button").find((node) => node.textContent === text || node.getAttribute("aria-label") === text) || null;
const click = (node) => node.dispatch("click");
const text = (node) => node.textContent.replace(/\s+/g, " ").trim();
const itemNode = (root, id) => all(root, "li").find((node) => node.dataset.curationItem === id) || null;
const given = (root) => all(all(root, "ol").find((node) => node.dataset.curationGiven === "true") || root, "li").filter((node) => node.dataset.curationItem).map((node) => node.dataset.curationItem);
const held = (root) => all(root, "li").filter((node) => node.dataset.curationItem && node.dataset.curationStatus === "withheld").map((node) => node.dataset.curationItem);
const previewed = (root) => all(root, "li").filter((node) => node.dataset.curationPreviewed).map((node) => node.dataset.curationPreviewed);
const alertText = (root) => {
  const box = all(root, "p").find((node) => node.dataset.curationError === "true");
  return box && !box.hidden ? box.textContent : "";
};
const status = (root) => all(root, "p").find((node) => node.dataset.curationStatus === "true")?.textContent || "";

// ---------------------------------------------------------------- the pure parts

test("the words for kinds, reasons and values never judge the research", () => {
  assert.deepEqual(Object.keys(CURATION_KINDS).sort(), ["comparison", "contextual-entry", "explanation", "reference", "relationship", "source-annotation", "timeline"]);
  for (const why of ["withdrawn", "stale", "target-missing", "not-approved", "not-published", "source-private", "post-not-published", "dependency-missing", "dependency-withheld", "cycle"]) {
    assert.ok(CURATION_WHY[why], `${why} has words`);
    assert.doesNotMatch(CURATION_WHY[why], /\b(score|verdict|false|true|wrong|credible|accepted)\b/i);
  }
  assert.equal(curationValueText({ kind: "author" }), "the site author");
  assert.equal(curationValueText({ kind: "named", name: "A later editor" }), "A later editor");
  assert.equal(curationValueText({ kind: "source", source: "scholar" }), "the source scholar");
  assert.equal(curationValueText([{ source: "burnet", locators: [{ kind: "page", value: "514", to: "515" }] }, "x"]), "burnet, page 514 to 515; x");
  assert.equal(curationValueText(null), "");
  assert.equal(curationPostSlug(" The Cave: Déjà vu! "), "the-cave-déjà-vu");
  assert.equal(curationPostSlug("!!!"), "");
});

test("moving a selection never leaves the list or loses another", () => {
  assert.deepEqual(curationMove(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(curationMove(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.deepEqual(curationMove(["a", "b", "c"], "a", -1), ["a", "b", "c"], "the first cannot go up");
  assert.deepEqual(curationMove(["a", "b", "c"], "c", 1), ["a", "b", "c"], "the last cannot go down");
  assert.deepEqual(curationMove(["a", "b"], "z", 1), ["a", "b"], "an unknown id changes nothing");
});

test("each item reads back from the public value, in the order its fields are listed", () => {
  const data = view();
  const relationship = data.preview.items.find((item) => item.kind === "relationship");
  const rows = curationItemRows(relationship);
  assert.ok(rows.some((row) => row.label === "Who asserts it"), "attribution is shown");
  assert.ok(rows.some((row) => row.label === "How firmly"), "confidence is shown");
  assert.ok(rows.some((row) => row.label === "The evidence"), "evidence is shown");
  assert.ok(rows.every((row) => row.value !== ""), "no empty row");
  const entry = data.preview.items.find((item) => item.kind === "contextual-entry" && item.target === "plato");
  assert.deepEqual(curationItemRows(entry).map((row) => row.name).slice(0, 2), ["label", "id"]);
  assert.match(curationItemRows(entry).find((row) => row.name === "summary").value, /Athenian philosopher/);
  assert.equal(curationSelectionName({ kind: "reference", label: "Platonis Opera", target: "burnet" }), "Source reference: Platonis Opera");
  assert.equal(curationStatusText({ status: "published" }), "Published to readers");
  assert.equal(curationStatusText({ status: "withheld", why: "stale" }), CURATION_WHY.stale);
});

// ---------------------------------------------------------------- the view

test("the section lists what readers get in the author's order, what is withheld and why, and what is for other posts", withDom(async () => {
  const { root } = await mount(server());
  const data = view();
  assert.deepEqual(given(root), data.preview.items.map((item) => item.id), "the list is the preview's order");
  assert.deepEqual(previewed(root), data.preview.items.map((item) => item.id));
  assert.deepEqual(held(root), ["comparison-cave", "entry-republic"].sort(), "withheld ones are told apart");
  const why = (id) => itemNode(root, id).dataset.curationWhy;
  assert.equal(why("entry-republic"), "stale");
  assert.equal(why("comparison-cave"), "withdrawn");
  assert.match(text(itemNode(root, "entry-republic")), /changed after you selected it/);
  assert.match(text(itemNode(root, "comparison-cave")), /rethinking the wording/, "the author's own reason is shown to them");
  // The selection for another post is listed apart, not previewed.
  const others = all(root, "details").find((node) => node.dataset.curationOthers === "true");
  assert.match(text(others), /Selected for other posts \(1\)/);
  assert.ok(!previewed(root).includes("annotation-other"));
  // Place in the post's order is in words, not only position.
  assert.match(text(itemNode(root, "entry-plato")), /Place 2 of 5 for this post/);
  assert.equal(status(root), "7 selections for this post, 5 given to readers.");
}));

test("the preview shows the exact public data and the caveats that travel with an item", withDom(async () => {
  const { root } = await mount(server());
  const data = view();
  const pre = all(root, "pre").map((node) => node.textContent);
  for (const item of data.preview.items) assert.ok(pre.includes(JSON.stringify(item, null, 2)), `${item.id} is shown exactly`);
  const dating = all(root, "li").find((node) => node.dataset.curationPreviewed === "dating-birth-a");
  assert.match(text(dating), /competing datings of the same aspect are published but not selected: plato-birth-b/);
  const reference = all(root, "li").find((node) => node.dataset.curationPreviewed === "reference-undated");
  assert.match(text(reference), /Not recorded, so left out and never invented: Creators, Date issued/);
  assert.match(text(reference), /Origin of the metadata: not recorded/);
  // Context comes with a relationship and says what needs it.
  const context = all(root, "li").filter((node) => node.dataset.curationContextItem);
  assert.ok(context.length > 0 && context.every((node) => /needed by/.test(text(node))));
  assert.doesNotMatch(root.textContent, new RegExp(PRIVATE));
  assert.ok(!text(root).includes("another post"), "another post's comment is never previewed");
}));

test("it is keyboard and screen-reader operable: names, states, live regions and reading order", withDom(async () => {
  const { root } = await mount(server());
  const section = root;
  assert.equal(section.tagName, "SECTION");
  assert.ok(section.getAttribute("aria-labelledby") && root.querySelector(`#${section.getAttribute("aria-labelledby")}`), "the region is named by its heading");
  const heading = all(root, "h4")[0];
  assert.equal(heading.textContent, "Selected for readers");
  // Every control is a native button with a name that says which item it acts on.
  for (const control of all(root, "button")) {
    assert.equal(control.getAttribute("type"), "button");
    const name = control.getAttribute("aria-label") || control.textContent;
    assert.ok(name && name.trim().length > 3, `a button has a name: ${control.textContent}`);
  }
  const plato = "Atlas entry: Plato";
  for (const verb of ["Move", "Withdraw", "Unselect"]) {
    assert.ok(all(root, "button").some((node) => node.getAttribute("aria-label")?.startsWith(verb) && node.getAttribute("aria-label").includes(plato)), `${verb} names the item`);
  }
  // The ends of the order cannot move past it, and say so by being disabled, not hidden.
  assert.equal(named(root, "Move Relationship: Plato authored Republic up").disabled, true);
  assert.equal(named(root, "Move Relationship: Plato authored Republic down").disabled, false);
  const last = given(root).at(-1);
  const lastName = curationSelectionName(view().selections.find((selection) => selection.id === last));
  assert.equal(named(root, `Move ${lastName} down`).disabled, true);
  // Lists are lists; the status is announced politely; an error is an alert.
  assert.ok(all(root, "ol").some((node) => node.dataset.curationGiven === "true"), "the order is an ordered list");
  const live = all(root, "p").find((node) => node.dataset.curationStatus === "true");
  assert.equal(live.getAttribute("role"), "status");
  assert.equal(live.getAttribute("aria-live"), "polite");
  const error = all(root, "p").find((node) => node.dataset.curationError === "true");
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(error.hidden, true);
  // Withheld and published are told apart in words, not by colour or border alone.
  assert.match(text(itemNode(root, "entry-republic")), /Withheld/);
  assert.match(text(itemNode(root, "entry-plato")), /Published/);
}));

// ---------------------------------------------------------------- changing

test("moving an item sends the whole new order with the revision, keeps focus on the same control and announces the place", withDom(async () => {
  const data = view();
  const moved = structuredClone(data);
  moved.revision = "b".repeat(64);
  const ids = data.preview.items.map((item) => item.id);
  moved.preview.items = [moved.preview.items[1], moved.preview.items[0], ...moved.preview.items.slice(2)];
  // The server lists the selections in the order readers get them.
  const first = moved.selections.findIndex((selection) => selection.id === ids[0]);
  const second = moved.selections.findIndex((selection) => selection.id === ids[1]);
  [moved.selections[first], moved.selections[second]] = [moved.selections[second], moved.selections[first]];
  const api = server(data, (method, path, body) => (method === "PUT" && path === "research/curation/order" ? moved : null));
  const { root } = await mount(api);
  const down = named(root, "Move Relationship: Plato authored Republic down");
  await click(down);
  const call = api.calls.find((entry) => entry.method === "PUT");
  assert.deepEqual(call.body, { revision: data.revision, post: "cave", order: [ids[1], ids[0], ...ids.slice(2)], rebuild: false });
  assert.deepEqual(given(root).slice(0, 2), [ids[1], ids[0]]);
  assert.match(status(root), /Relationship: Plato authored Republic is now 2 of 5\./);
  // The same control, which now sits one place down, still has the focus.
  assert.equal(document.activeElement.getAttribute("aria-label"), "Move Relationship: Plato authored Republic down");
  // The next change names the revision the last one returned.
  await click(named(root, "Move Relationship: Plato authored Republic up"));
  assert.equal(api.calls.filter((entry) => entry.method === "PUT").at(-1).body.revision, moved.revision);
}));

test("a run of reorders is saved step by step and rebuilds the served site once, saying how it went", withDom(async () => {
  const data = view();
  const ids = data.preview.items.map((item) => item.id);
  const moved = structuredClone(data);
  moved.revision = "b".repeat(64);
  moved.build = { ok: true, pending: true };
  const api = server(data, (method, path) => {
    if (method === "PUT" && path === "research/curation/order") return moved;
    if (method === "POST" && path === "research/curation/rebuild") return { build: { ok: true, files: 12 } };
    return null;
  });
  const { root } = await mount(api, "cave", { rebuildDelay: 20 });
  await click(named(root, "Move Relationship: Plato authored Republic down"));
  assert.match(status(root), /The served site will be rebuilt in a moment\./);
  await click(named(root, "Move Relationship: Plato authored Republic up"));
  assert.equal(api.calls.filter((entry) => entry.method === "POST").length, 0, "nothing rebuilds between steps");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const rebuilds = api.calls.filter((entry) => entry.method === "POST" && entry.path === "research/curation/rebuild");
  assert.equal(rebuilds.length, 1, "one rebuild after the last step");
  assert.match(status(root), /Order saved\. The served site was rebuilt\./);
  assert.ok(ids.length > 1);
}));

test("a rebuild that fails after a change is shown in the status line, with the reason", withDom(async () => {
  const data = view();
  const created = structuredClone(data);
  created.revision = "c".repeat(64);
  created.changed = "annotation-new";
  created.build = { ok: false, error: "the site could not be built: disk full." };
  const api = server(data, (method, path) => (method === "POST" && path === "research/curation/selections" ? created : null));
  const { section, root } = await mount(api);
  section.start({ kind: "source-annotation", target: "burnet", label: "Platonis Opera" });
  const form = all(root, "form").find((node) => node.getAttribute("aria-labelledby"));
  form.querySelector("#oba-curation-form-text").value = "A comment of mine.";
  form.querySelector("#oba-curation-form-by").value = "The author";
  await form.dispatch("submit");
  const line = all(root, "p").find((node) => node.dataset.curationStatus === "true");
  assert.match(line.textContent, /was saved, but rebuilding the served site failed: the site could not be built: disk full\. Readers still see the site as it was\./);
  assert.match(line.className, /oba-error/);
  // A reload that finds a rebuild still owed says so and schedules it.
  const pending = structuredClone(data);
  pending.build = { ok: true, pending: true };
  const later = server(pending, (method, path) => (method === "POST" && path === "research/curation/rebuild" ? { build: { ok: false, error: "no space" } } : null));
  const second = await mount(later, "cave", { rebuildDelay: 10 });
  assert.match(status(second.root), /will be rebuilt in a moment/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(status(second.root), /Order saved\. The change was saved, but rebuilding the served site failed: no space/);
}));

test("selecting walks through the fields, sends only what was chosen and keeps the form when it is refused", withDom(async () => {
  const data = view();
  const created = structuredClone(data);
  created.revision = "c".repeat(64);
  created.changed = "annotation-new";
  created.selections.push({ id: "annotation-new", kind: "source-annotation", target: "burnet", label: "Platonis Opera", state: "selected", status: "published", appliesToPost: true, fields: ["by", "text"], provenance: { origin: "unrecorded" }, posts: ["cave"] });
  let refuse = true;
  const api = server(data, (method, path, body) => {
    if (method !== "POST" || path !== "research/curation/selections") return null;
    if (refuse) return new ApiError("Selection `x`: the source `diary` is not cited by a published post. Nothing was changed.", 422, { error: "Selection `x`: the source `diary` is not cited by a published post. Nothing was changed." });
    return created;
  });
  const { section, root } = await mount(api);
  const opener = { focus() { document.activeElement = this; } };
  section.start({ kind: "source-annotation", target: "burnet", label: "Platonis Opera", opener });
  const form = all(root, "form").find((node) => node.getAttribute("aria-labelledby"));
  assert.ok(form, "the form is shown");
  assert.equal(document.activeElement.textContent, "Select for readers: Platonis Opera", "focus moves to the form's heading");
  // Every field has a label and the groups are named.
  for (const field of all(form, "input").concat(all(form, "textarea"))) {
    if (field.getAttribute("aria-label")) continue;
    assert.ok(all(form, "label").some((label) => label.getAttribute("for") === field.id), `${field.id} has a label`);
  }
  assert.ok(all(form, "fieldset").every((fieldset) => all(fieldset, "legend").length === 1));
  assert.match(text(form), /Always included, so it cannot be left out: Who wrote it, The words\./);
  // The hint says honestly that the words become public and excuse any words copied from a private note.
  assert.match(text(form), /become public.*public everywhere on the site; the note.s other sentences stay protected/);
  const set = (id, value) => {
    const node = form.querySelector(`#${id}`);
    node.value = value;
    return node;
  };
  set("oba-curation-form-text", "A comment of mine.");
  set("oba-curation-form-by", "The author");
  set("oba-curation-form-locator", "514a");
  await form.dispatch("submit");
  assert.equal(alertText(root).startsWith("Selection `x`: the source `diary`"), true, "the refusal is shown where it happened");
  assert.equal(document.activeElement.dataset.curationError, "true", "focus goes to the message");
  // Nothing was lost: the form is still there with what was typed.
  assert.equal(form.querySelector("#oba-curation-form-text").value, "A comment of mine.");
  assert.ok(all(root, "form").some((node) => node === form));
  const sent = api.calls.find((entry) => entry.method === "POST");
  assert.deepEqual(sent.body, { revision: data.revision, post: "cave", selection: { kind: "source-annotation", target: "burnet", optionalFields: ["locator"], posts: ["cave"], text: "A comment of mine.", by: "The author", locator: "514a" } });
  refuse = false;
  await form.dispatch("submit");
  assert.equal(alertText(root), "");
  assert.ok(!all(root, "form").some((node) => node === form), "the form closes once it is saved");
  assert.ok(itemNode(root, "annotation-new"));
  assert.match(status(root), /Selected Your comment on a source: Platonis Opera for readers/);
  assert.equal(document.activeElement.getAttribute("aria-label"), "Withdraw Your comment on a source: Platonis Opera", "focus lands on the new item");
}));

test("cancelling a selection returns focus to the control that opened it and sends nothing", withDom(async () => {
  const api = server();
  const { section, root } = await mount(api);
  const opener = { focus() { document.activeElement = this; } };
  section.start({ kind: "reference", target: "scholar", label: "A study", opener });
  assert.match(text(all(root, "form")[0]), /Where this metadata came from/, "a reference asks where its metadata came from");
  assert.equal(all(root, "form")[0].querySelector("#oba-curation-form-origin-unrecorded").checked, true, "unrecorded is the default, never authored");
  await click(named(root, "Cancel"));
  assert.equal(document.activeElement, opener);
  assert.equal(all(root, "form").length, 0);
  assert.equal(api.calls.filter((entry) => entry.method !== "GET").length, 0);
}));

test("withdrawing asks for an optional reason, closes on Escape and sends the reason", withDom(async () => {
  const data = view();
  const after = structuredClone(data);
  after.revision = "d".repeat(64);
  const api = server(data, (method, path, body) => (method === "PUT" && path === "research/curation/selections" ? after : null));
  const { root } = await mount(api);
  const name = "Atlas entry: Plato";
  await click(named(root, `Withdraw ${name}`));
  const reason = document.activeElement;
  assert.equal(reason.getAttribute("type"), "text", "focus moves to the reason");
  assert.equal(named(root, `Withdraw ${name}`).getAttribute("aria-expanded"), "true");
  // Escape closes it and returns focus to the control that opened it.
  const form = all(root, "form").find((node) => node.dataset.curationConfirmForm === "withdraw");
  await form.dispatch("keydown", { key: "Escape", stopPropagation() {} });
  assert.equal(document.activeElement.getAttribute("aria-label"), `Withdraw ${name}`);
  assert.equal(api.calls.filter((entry) => entry.method === "PUT").length, 0);
  await click(named(root, `Withdraw ${name}`));
  document.activeElement.value = "rethinking";
  await all(root, "form").find((node) => node.dataset.curationConfirmForm === "withdraw").dispatch("submit");
  assert.deepEqual(api.calls.find((entry) => entry.method === "PUT").body, { revision: data.revision, post: "cave", action: "withdraw", id: "entry-plato", reason: "rethinking" });
}));

test("a stale or withdrawn selection offers to select it again and never offers to withdraw it", withDom(async () => {
  const data = view();
  const api = server(data, (method, path, body) => (body?.action === "reselect" ? { ...data, revision: "e".repeat(64) } : null));
  const { root } = await mount(api);
  for (const id of ["entry-republic", "comparison-cave"]) {
    const row = itemNode(root, id);
    assert.ok(all(row, "button").some((node) => node.textContent === "Select again"), `${id} can be selected again`);
    assert.ok(!all(row, "button").some((node) => node.textContent === "Withdraw"), `${id} is not offered a withdrawal`);
    assert.ok(!all(row, "button").some((node) => /^Move/.test(node.textContent)), `${id} cannot be ordered while it publishes nothing`);
  }
  await click(named(root, "Select Atlas entry: Republic again"));
  assert.deepEqual(api.calls.find((entry) => entry.method === "PUT").body, { revision: data.revision, post: "cave", action: "reselect", id: "entry-republic" });
}));

test("unselecting asks first, says the research is untouched, and returns focus to the list", withDom(async () => {
  const data = view();
  const after = structuredClone(data);
  after.revision = "f".repeat(64);
  after.selections = after.selections.filter((selection) => selection.id !== "entry-plato");
  after.preview.items = after.preview.items.filter((item) => item.id !== "entry-plato");
  const api = server(data, (method) => (method === "DELETE" ? after : null));
  const { root } = await mount(api);
  await click(named(root, "Unselect Atlas entry: Plato"));
  const confirm = all(root, "div").find((node) => node.dataset.curationConfirmForm === "unselect");
  assert.match(text(confirm), /removes your selection only\. The research it selects is not changed\./);
  assert.equal(api.calls.filter((entry) => entry.method === "DELETE").length, 0, "nothing is sent until it is confirmed");
  await click(all(confirm, "button").find((node) => node.textContent === "Unselect"));
  assert.deepEqual(api.calls.find((entry) => entry.method === "DELETE").body, { revision: data.revision, post: "cave", id: "entry-plato" });
  assert.equal(itemNode(root, "entry-plato"), null);
  assert.match(document.activeElement.textContent, /^Given to readers \(4\)/);
}));

test("a conflict reloads and says nothing was changed; a refusal changes nothing either", withDom(async () => {
  const data = view();
  const newer = structuredClone(data);
  newer.revision = "9".repeat(64);
  let first = true;
  const api = server(data, (method, path) => {
    if (method !== "PUT") return null;
    if (first) {
      first = false;
      api.state.view = newer;
      return new ApiError("changed", 409, { conflict: true, revision: newer.revision });
    }
    return new ApiError("Selection `entry-plato` is stale: check what it selects and select it again before changing where it appears. Nothing was changed.", 422, { error: "Selection `entry-plato` is stale: check what it selects and select it again before changing where it appears. Nothing was changed." });
  });
  const { root } = await mount(api);
  await click(named(root, "Move Relationship: Plato authored Republic down"));
  assert.match(alertText(root), /changed elsewhere since you read them\. They are reloaded; nothing was changed\./);
  assert.equal(api.calls.filter((entry) => entry.method === "GET").length, 2, "the view was read again");
  await click(named(root, "Move Relationship: Plato authored Republic down"));
  assert.equal(api.calls.filter((entry) => entry.method === "PUT").at(-1).body.revision, newer.revision, "it names the revision it reloaded");
  assert.match(alertText(root), /is stale: check what it selects/);
  assert.equal(given(root).length, 5, "the list is as it was");
}));

test("a session that ended is handed back and a view that cannot be read is said so, not guessed", withDom(async () => {
  let ended = 0;
  const api = { async call() { throw new ApiError("Session expired", 401, null); } };
  const section = createCurationSection({ api, getPost: () => "cave", onSessionEnded: () => { ended += 1; } });
  document.body.append(section.element);
  await section.load();
  assert.equal(ended, 1);
  const broken = createCurationSection({ api: { async call() { throw new ApiError("boom", 422, { error: "The curated selections cannot be read. Nothing was changed." }); } }, getPost: () => "cave" });
  document.body.append(broken.element);
  await broken.load();
  assert.match(status(broken.element), /Your selections could not be read\. The curated selections cannot be read/);
  assert.equal(given(broken.element).length, 0);
}));

test("without a post slug the section offers the whole site only and does not offer ordering", withDom(async () => {
  const data = view();
  data.post = undefined;
  for (const selection of data.selections) selection.appliesToPost = true;
  const { section, root } = await mount(server(data), "");
  assert.ok(!all(root, "button").some((node) => /^Move/.test(node.textContent)));
  section.start({ kind: "contextual-entry", target: "plato", label: "Plato" });
  const form = all(root, "form")[0];
  assert.equal(form.querySelector("#oba-curation-form-post").disabled, true);
  assert.equal(form.querySelector("#oba-curation-form-site").checked, true);
  assert.match(text(form), /give the post a slug first/);
}));

test("a site that does not publish curated context says so and nothing else changes", withDom(async () => {
  const data = view();
  data.publish = false;
  const { root } = await mount(server(data));
  const note = all(root, "p").find((node) => node.dataset.curationSwitch === "off");
  assert.match(note.textContent, /does not publish curated context/);
  assert.match(note.textContent, /curatedContext\.publish/);
}));

// ---------------------------------------------------------------- in the research panel

const panelData = () => ({
  library: {
    revision: "lib-1",
    sources: [
      { id: "burnet", kind: "edition", of: "republic", title: "Platonis Opera" },
      { id: "diary", kind: "work", title: "A private diary" },
    ],
    interpretations: [],
  },
  notebook: { revision: "nb-1", passages: [], notes: [] },
  atlas: {
    publish: true,
    url: "/atlas/",
    entries: [
      { id: "plato", kind: "person", label: "Plato", aliases: [], approved: true, url: "/atlas/plato/", datings: [{ id: "plato-birth-a", aspect: "birth", text: "428 BCE" }] },
      { id: "secret", kind: "concept", label: "A private entry", aliases: [], approved: false, url: null, datings: [] },
    ],
  },
  comparisons: { publish: true, url: "/comparisons/", items: [{ id: "cave", label: "The cave", approved: true, url: "/comparisons/cave/", interpretations: [] }] },
});

function panelServer(extra = () => null) {
  const research = panelData();
  const curation = view();
  curation.candidates.sources = [{ id: "burnet", label: "Platonis Opera" }];
  return {
    calls: [],
    async call(method, path, options = {}) {
      this.calls.push({ method, path, body: options.json });
      if (method === "GET" && path === "research/draft") return structuredClone(research);
      if (method === "GET" && path.startsWith("research/curation")) return structuredClone(curation);
      const reply = extra(method, path, options.json);
      if (reply) return reply;
      throw new ApiError(`unexpected ${method} ${path}`, 500, null);
    },
  };
}

test("the research panel hosts the section and offers only public items for selection", withDom(async () => {
  const api = panelServer();
  const panel = createDraftResearchPanel({ api, insert: () => "", getPost: () => "cave" });
  document.body.append(panel.element);
  await panel.load();
  const section = panel.element.querySelector(".oba-curation");
  assert.ok(section, "the panel hosts the section; it is not a second panel");
  assert.equal(all(document.body, "aside").length, 1);
  const open = (key) => all(panel.element, "button").find((node) => node.dataset.draftItem === key).dispatch("click");
  // A public source can be selected as a reference and annotated.
  await open("source:burnet");
  const names = () => all(panel.element, "button").filter((node) => node.dataset.curationStart).map((node) => node.dataset.curationStart);
  assert.deepEqual(names(), ["reference:burnet", "source-annotation:burnet"]);
  // A source nothing makes public says why instead of offering it.
  await open("source:diary");
  assert.deepEqual(names(), []);
  assert.match(text(panel.element.querySelector("[data-draft-research-curate]")), /Not selectable yet: it is not made public by a published post, the atlas or a comparison\. Selecting never approves it\./);
  // An approved entry: the entry, an explanation, its dating and its relationship.
  await open("atlas:plato");
  assert.deepEqual(names(), ["contextual-entry:plato", "explanation:plato", "timeline:plato-birth-a", "relationship:r-authored", "relationship:r-member"]);
  // A private entry has no controls at all.
  await open("atlas:secret");
  assert.deepEqual(names(), []);
  // A comparison.
  await open("comparison:cave");
  assert.deepEqual(names(), ["comparison:cave"]);
  // Choosing one opens the form in the section and moves focus there.
  await all(panel.element, "button").find((node) => node.dataset.curationStart === "comparison:cave").dispatch("click", { currentTarget: { focus() {} } });
  assert.match(document.activeElement.textContent, /^Select for readers: The cave/);
}));

test("the boundary preview of a post shows the curated report's notices beside the item", withDom(async () => {
  const manifest = {
    scope: { kind: "post", slug: "cave", path: "posts/cave.md" },
    projections: [
      {
        projection: "curated",
        switch: "curatedContext.publish",
        enabled: true,
        published: [{ kind: "selection", id: "dating-birth-a", label: "428 BCE", posts: ["cave"], fields: ["text"], notices: [{ code: "competing-unselected", message: "Selection `dating-birth-a`: competing datings of the same aspect are published but not selected: plato-birth-b." }] }],
        withheld: [{ kind: "selection", id: "entry-republic", reason: "stale-selection", message: "Selection `entry-republic` was selected before the entry `republic` or something it depends on changed." }],
      },
    ],
    never: [],
  };
  const preview = createBoundaryPreview({ manifest, idPrefix: "t", level: 4, scope: "post" });
  document.body.append(preview);
  assert.match(text(preview), /Curated for readers/);
  const notice = all(preview, "li").find((node) => node.dataset.boundaryNotice === "competing-unselected");
  assert.match(text(notice), /competing unselected: Selection `dating-birth-a`/);
  assert.match(text(preview), /Selected before it changed: select it again/);
}));

test("the page ships the styles that keep the section inside 320 pixels", () => {
  const css = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf(".oba-curation {"));
  assert.match(block, /\.oba-curation \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/s);
  assert.match(css, /\.oba-curation-exact pre \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/s);
  assert.match(css, /@media \(max-width: 24rem\)[^{]*\{[^}]*\.oba-curation-item \.oba-toolbar \.oba-btn/s);
});

// ---------------------------------------------------------------- review fixes for #196

test("a conflict keeps what was typed in the half-filled form and reloads the list and preview", withDom(async () => {
  const data = view();
  const newer = structuredClone(data);
  newer.revision = "8".repeat(64);
  newer.preview.items = newer.preview.items.slice(1);
  let conflict = true;
  const api = server(data, (method, path) => {
    if (method !== "POST") return null;
    if (conflict) {
      conflict = false;
      api.state.view = newer;
      return new ApiError("changed", 409, { conflict: true, revision: newer.revision });
    }
    return { ...newer, revision: "7".repeat(64), changed: "annotation-new" };
  });
  const { section, root } = await mount(api);
  section.start({ kind: "reference", target: "scholar", label: "A study", opener: { focus() {} } });
  const form = all(root, "form")[0];
  form.querySelector("#oba-curation-form-origin-imported").checked = true;
  form.querySelector("#oba-curation-form-origin-unrecorded").checked = false;
  form.querySelector("#oba-curation-form-origin-from").value = "the library catalogue";
  await form.dispatch("submit");
  assert.match(alertText(root), /changed elsewhere since you read them/);
  assert.equal(api.calls.filter((entry) => entry.method === "GET").length, 2, "the view was read again");
  assert.deepEqual(previewed(root), newer.preview.items.map((item) => item.id), "the preview shows the newer view");
  // The same form, with what was chosen, is still there.
  const kept = all(root, "form")[0];
  assert.equal(kept, form, "the form was not rebuilt");
  assert.equal(kept.querySelector("#oba-curation-form-origin-imported").checked, true);
  assert.equal(kept.querySelector("#oba-curation-form-origin-from").value, "the library catalogue");
  // Choosing again sends the same values against the newer revision.
  await kept.dispatch("submit");
  const posts = api.calls.filter((entry) => entry.method === "POST");
  assert.equal(posts[1].body.revision, newer.revision);
  assert.deepEqual(posts[1].body.selection.provenance, { origin: "imported", from: "the library catalogue" });
}));

test("a conflict also keeps a comment text, who it is by and where it applies", withDom(async () => {
  const data = view();
  const newer = structuredClone(data);
  newer.revision = "6".repeat(64);
  const api = server(data, (method) => {
    if (method !== "POST") return null;
    api.state.view = newer;
    return new ApiError("changed", 409, { conflict: true, revision: newer.revision });
  });
  const { section, root } = await mount(api);
  section.start({ kind: "source-annotation", target: "burnet", label: "Platonis Opera" });
  const form = all(root, "form")[0];
  form.querySelector("#oba-curation-form-text").value = "A long comment I would hate to retype.";
  form.querySelector("#oba-curation-form-by").value = "The author";
  form.querySelector("#oba-curation-form-locator").value = "514a";
  form.querySelector("#oba-curation-form-site").checked = true;
  await form.dispatch("submit");
  const kept = all(root, "form")[0];
  assert.equal(kept.querySelector("#oba-curation-form-text").value, "A long comment I would hate to retype.");
  assert.equal(kept.querySelector("#oba-curation-form-by").value, "The author");
  assert.equal(kept.querySelector("#oba-curation-form-locator").value, "514a");
  assert.equal(kept.querySelector("#oba-curation-form-site").checked, true);
}));

test("Escape in the unselect confirmation and in the new-selection form closes only that, never the panel", withDom(async () => {
  const api = server();
  const { section, root } = await mount(api);
  const name = "Atlas entry: Plato";
  await click(named(root, `Unselect ${name}`));
  const confirm = all(root, "div").find((node) => node.dataset.curationConfirmForm === "unselect");
  let stopped = 0;
  await confirm.dispatch("keydown", { key: "Escape", stopPropagation() { stopped += 1; } });
  assert.equal(stopped, 1, "the event went no further");
  assert.ok(!all(root, "div").some((node) => node.dataset.curationConfirmForm === "unselect"), "the confirmation closed");
  assert.equal(document.activeElement.getAttribute("aria-label"), `Unselect ${name}`, "focus is back on the control");
  // Another key does nothing.
  await click(named(root, `Unselect ${name}`));
  await all(root, "div").find((node) => node.dataset.curationConfirmForm === "unselect").dispatch("keydown", { key: "a", stopPropagation() { stopped += 1; } });
  assert.equal(stopped, 1);
  // The new-selection form.
  const opener = { focus() { document.activeElement = this; } };
  section.start({ kind: "reference", target: "scholar", label: "A study", opener });
  await all(root, "form")[0].dispatch("keydown", { key: "Escape", stopPropagation() { stopped += 1; } });
  assert.equal(stopped, 2);
  assert.equal(all(root, "form").length, 0, "the form closed");
  assert.equal(document.activeElement, opener);
  assert.equal(api.calls.filter((entry) => entry.method !== "GET").length, 0, "nothing was sent");
}));

test("a draft's own selections are labelled as for when the post is published, and can still be ordered", withDom(async () => {
  const data = view();
  data.whenPublished = true;
  const { root } = await mount(server(data));
  assert.match(text(root), /This post is not published yet\. Its selections are shown as they will be when this post is published/);
  assert.match(text(all(root, "h5").find((node) => /^What readers of this post get/.test(node.textContent))), /when this post is published$/);
  assert.match(text(itemNode(root, "entry-plato")), /Published with this post/);
  assert.equal(named(root, "Move Relationship: Plato authored Republic down").disabled, false, "ordering is allowed");
}));

test("a published post is not labelled as unpublished", withDom(async () => {
  const { root } = await mount(server());
  assert.doesNotMatch(text(root), /not published yet/);
  assert.match(text(all(root, "h5").find((node) => /^What readers of this post get/.test(node.textContent))), /^What readers of this post get$/);
}));

test("the section reads its view again when the post address changes, and never changes another post", withDom(async () => {
  let slug = "cave";
  const data = view();
  const api = server(data, () => null);
  const section = createCurationSection({ api, getPost: () => slug });
  document.body.append(section.element);
  await section.load();
  assert.equal(api.calls.filter((entry) => entry.method === "GET").length, 1);
  await section.sync();
  assert.equal(api.calls.filter((entry) => entry.method === "GET").length, 1, "nothing to do while the address is the same");
  slug = "the-cave";
  const other = structuredClone(data);
  other.post = "the-cave";
  api.state.view = other;
  await section.sync();
  assert.equal(api.calls.filter((entry) => entry.method === "GET").at(-1).path, "research/curation?post=the-cave");
  slug = "renamed-again";
  // A change made before it is reread is refused locally and sends nothing.
  await click(named(section.element, "Move Relationship: Plato authored Republic down"));
  assert.equal(api.calls.filter((entry) => entry.method !== "GET").length, 0);
  assert.match(alertText(section.element), /address changed since you read its selections/);
}));

test("the research panel redraws an open item when the selections load or change", withDom(async () => {
  const api = panelServer();
  const panel = createDraftResearchPanel({ api, insert: () => "", getPost: () => "cave" });
  document.body.append(panel.element);
  await panel.load();
  const open = (key) => all(panel.element, "button").find((node) => node.dataset.draftItem === key).dispatch("click");
  await open("atlas:plato");
  const selectedLine = () => panel.element.querySelector("[data-draft-research-selected]");
  assert.match(text(selectedLine()), /Already selected for readers: .*Atlas entry: Plato/, "selected as the view loaded");
  // The view changes (here, reloaded without the selection): the open item follows it.
  const fewer = view();
  fewer.selections = fewer.selections.filter((selection) => selection.target !== "plato");
  const original = api.call.bind(api);
  api.call = async (method, path, options) => (method === "GET" && path.startsWith("research/curation") ? structuredClone(fewer) : original(method, path, options));
  await panel.curation.load();
  assert.doesNotMatch(text(selectedLine()), /Atlas entry: Plato/, "the line follows the selections");
}));
