import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACCENT_SWATCHES,
  CHOICES,
  CONTROL_ORDER,
  applyCurated,
  clearControl,
  compareLooks,
  controlSummary,
  lookErrorText,
  lookFrom,
  lookPayload,
  lookSame,
  pushHistory,
  setControl,
  valueWords,
} from "../../web/admin/look.js";
import { createDraftStore } from "../../web/admin/landing.js";

test("a look keeps only the controls the screen knows and drops the theme's own", () => {
  assert.deepEqual(lookFrom({ version: 1, accent: "#aa2244", fontStyle: "theme", extra: "x", textSize: "" }), { accent: "#aa2244" });
  assert.deepEqual(lookFrom(null), {});
  assert.deepEqual(lookFrom([1]), {});
});

test("payloads are versioned with only the chosen controls, and empty means the theme as it is", () => {
  assert.deepEqual(lookPayload({}), {});
  assert.deepEqual(lookPayload({ textSize: "large", accent: "#112233" }), { version: 1, accent: "#112233", textSize: "large" });
  assert.ok(lookSame({ textSize: "large" }, { textSize: "large" }));
  assert.ok(!lookSame({ textSize: "large" }, { textSize: "small" }));
});

test("choosing and clearing never change the look they were given", () => {
  const start = { textSize: "large" };
  const next = setControl(start, "roundness", "round");
  assert.deepEqual(start, { textSize: "large" });
  assert.deepEqual(next, { textSize: "large", roundness: "round" });
  assert.deepEqual(clearControl(next, "textSize"), { roundness: "round" });
  assert.deepEqual(setControl(start, "css", "body{}"), start);
});

test("a curated look sets its palette and font and clears a chosen accent", () => {
  const next = applyCurated({ accent: "#112233", textSize: "large" }, { id: "warm", fontStyle: "classic-serif" });
  assert.deepEqual(next, { palette: "warm", fontStyle: "classic-serif", textSize: "large" });
});

test("every control has words, and every choice and swatch is a closed value", () => {
  for (const id of CONTROL_ORDER) assert.ok(controlSummary(id, {}).startsWith("Using the theme's own"));
  assert.equal(controlSummary("textSize", { textSize: "extra-large" }), "Chosen: Extra large.");
  assert.equal(valueWords("accent", "#0f766e"), "Teal");
  assert.equal(valueWords("palette", "warm", [{ id: "warm", name: "Warm" }]), "Warm");
  for (const swatch of ACCENT_SWATCHES) assert.match(swatch.hex, /^#[0-9a-f]{6}$/);
  for (const [id, list] of Object.entries(CHOICES)) assert.ok(list.every((choice) => /^[a-z-]+$/.test(choice.id)), id);
});

test("the choices match the server's closed lists", () => {
  const rust = readFileSync(new URL("../../crates/openblog-core/src/look.rs", import.meta.url), "utf8");
  const ids = (name) => {
    const body = rust.match(new RegExp(`${name} \\{([\\s\\S]*?)\\}`))[1];
    return [...body.matchAll(/=>\s*"([a-z-]+)"/g)].map((m) => m[1]);
  };
  assert.deepEqual(CHOICES.fontStyle.map((c) => c.id), ids("FontStyle"));
  assert.deepEqual(CHOICES.textSize.map((c) => c.id), ids("TextSize"));
  assert.deepEqual(CHOICES.roundness.map((c) => c.id), ids("Roundness"));
  assert.deepEqual(CHOICES.spacing.map((c) => c.id), ids("Spacing"));
  assert.deepEqual(CHOICES.pageWidth.map((c) => c.id), ids("PageWidth"));
  assert.deepEqual(CHOICES.headingWeight.map((c) => c.id), ids("HeadingWeight"));
});

test("comparing two looks names what differs in words", () => {
  const rows = compareLooks({ roundness: "soft", textSize: "large" }, { roundness: "square", spacing: "airy", textSize: "large" });
  assert.deepEqual(rows.map((row) => [row.label, row.mine, row.theirs]), [
    ["Corners", "Soft", "Square"],
    ["Spacing", "the theme's own", "Roomy"],
  ]);
  assert.deepEqual(compareLooks({}, {}), []);
});

test("undo history is a bounded list of copies", () => {
  let history = [];
  const look = { textSize: "large" };
  history = pushHistory(history, look);
  look.textSize = "small";
  assert.equal(history[0].textSize, "large");
  for (let i = 0; i < 60; i += 1) history = pushHistory(history, { n: i });
  assert.equal(history.length, 50);
});

test("error words are plain and never empty", () => {
  assert.match(lookErrorText({ status: 401 }), /signed out/);
  assert.equal(lookErrorText({ data: { error: "Nope" } }), "Nope");
  assert.ok(lookErrorText({}).length > 0);
});

test("the draft store keeps a look, and refuses a shape that is not one", () => {
  const memory = new Map();
  const storage = () => ({ getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) });
  const store = createDraftStore("look-test", storage, (value) => !Array.isArray(value));
  store.save({ textSize: "large" }, "etag-1");
  assert.deepEqual(store.load().page, { textSize: "large" });
  assert.equal(store.load().base, "etag-1");
  store.clear();
  assert.equal(store.load(), null);
  memory.set("look-test", JSON.stringify({ v: 1, base: null, page: [1], savedAt: "x" }));
  assert.equal(store.load(), null);
});
