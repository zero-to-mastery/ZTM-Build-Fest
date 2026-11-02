// Tests for the pure reading-mode rules (web/components/reading-modes.js). The contract they check
// lives once in tests/fixtures/reading-modes.json; the Rust tests read the same file.
// Run with: node --test tests/web/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LABELS,
  MODES,
  STORAGE_KEY,
  announcement,
  clearPreference,
  countsByMode,
  describe,
  isMode,
  pagePath,
  printNote,
  readPreference,
  resolveMode,
  shouldShow,
  shows,
  storageKey,
  writePreference,
} from "../../web/components/reading-modes.js";

const contract = JSON.parse(readFileSync(new URL("../fixtures/reading-modes.json", import.meta.url), "utf8"));

const memory = () => {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
  };
};
const denied = {
  getItem() { throw new DOMException("denied", "SecurityError"); },
  setItem() { throw new DOMException("denied", "SecurityError"); },
  removeItem() { throw new DOMException("denied", "SecurityError"); },
};

test("the three modes and the key are the contract's", () => {
  assert.deepEqual(MODES, contract.modes);
  assert.equal(STORAGE_KEY, contract.storageKey);
  for (const mode of MODES) assert.ok(LABELS[mode]);
  assert.ok(!isMode("Guided") && !isMode("deep") && !isMode(null) && !isMode(undefined));
});

test("a mode shows exactly the supplements the contract says, and a warning is always shown", () => {
  for (const mode of contract.modes) {
    for (const level of contract.levels) {
      assert.equal(shows(mode, level), contract.shows[mode][level], `${mode} ${level}`);
    }
    // An unknown level is never shown by a mode, but a warning always is.
    assert.equal(shows(mode, "other"), false);
    assert.equal(shows(mode, "deep-dive", true), contract.alwaysShown.includes(mode));
    assert.equal(shows(mode, "guided", true), true);
  }
});

test("the mode to open in is the reader's choice, then the author's default, then standard", () => {
  for (const row of contract.resolve) {
    assert.equal(resolveMode(row.preference, row.default), row.mode, JSON.stringify(row));
  }
});

test("the saved choice is read and written defensively and only holds a mode", () => {
  const store = memory();
  assert.equal(readPreference(store), null);
  assert.equal(writePreference(store, "guided"), true);
  assert.equal(store.data.get(STORAGE_KEY), "guided");
  assert.equal(readPreference(store), "guided");
  store.data.set(STORAGE_KEY, "<script>");
  assert.equal(readPreference(store), null, "a value that is not a mode is ignored");
  assert.equal(writePreference(store, "<script>"), false);
  assert.equal(store.data.get(STORAGE_KEY), "<script>", "a refused write changes nothing");
  assert.equal(clearPreference(store), true);
  assert.equal(readPreference(store), null);
});

test("blocked or missing storage never throws and leaves the page working", () => {
  assert.equal(readPreference(denied), null);
  assert.equal(writePreference(denied, "guided"), false);
  assert.equal(clearPreference(denied), false);
  for (const none of [null, undefined]) {
    assert.equal(readPreference(none), null);
    assert.equal(writePreference(none, "guided"), false);
    assert.equal(clearPreference(none), false);
  }
  assert.equal(resolveMode(readPreference(denied), "guided"), "guided");
});

test("counts and descriptions say what each mode shows", () => {
  const items = [
    { level: "guided", always: false },
    { level: "deep-dive", always: false },
    { level: "deep-dive", always: true },
  ];
  assert.deepEqual(countsByMode(items), { standard: 1, guided: 2, "deep-dive": 3 });
  assert.equal(describe("standard", 0, 3), "The article alone.");
  assert.equal(describe("standard", 1, 3), "The article, with 1 supplement that holds a warning.");
  assert.equal(describe("standard", 2, 3), "The article, with 2 supplements that hold a warning.");
  assert.match(describe("guided", 2, 3), /short explanations: 2 of 3 supplements shown/);
  assert.match(describe("deep-dive", 1, 1), /1 of 1 supplement shown/);
});

test("a mode change is announced with its name and how many supplements are shown", () => {
  assert.equal(announcement("guided", 2, 3), "Guided reading. Showing 2 of 3 supplements.");
  assert.equal(announcement("deep-dive", 1, 1), "Deep dive reading. Showing 1 of 1 supplement.");
  assert.equal(announcement("standard", 0, 3), "Standard reading. No supplements shown.");
});

test("a supplement with a level the page cannot read is never hidden", () => {
  for (const mode of contract.modes) {
    for (const level of contract.levels) {
      assert.equal(shouldShow(mode, level), contract.shows[mode][level], `${mode} ${level}`);
    }
    for (const unknown of ["other", "", null, undefined, "Guided"]) {
      assert.equal(shouldShow(mode, unknown), true, `${mode} ${unknown}`);
    }
  }
  assert.deepEqual(countsByMode([{ level: "mystery", always: false }]), { standard: 1, guided: 1, "deep-dive": 1 });
});

test("the saved choice is kept under the site's base path, so sibling project sites do not share it", () => {
  assert.equal(storageKey(""), STORAGE_KEY);
  assert.equal(storageKey(undefined), STORAGE_KEY);
  assert.equal(storageKey("/blog"), `${STORAGE_KEY}:/blog`);
  assert.equal(storageKey("/blog/"), `${STORAGE_KEY}:/blog`);
  assert.notEqual(storageKey("/one"), storageKey("/two"));
  // Anything that is not a plain absolute path is the root.
  for (const odd of ["blog", "/", "//", null, 4, "x".repeat(300)]) assert.equal(storageKey(odd), STORAGE_KEY, String(odd));
  const store = memory();
  const one = storageKey("/one");
  const two = storageKey("/two");
  assert.equal(writePreference(store, "guided", one), true);
  assert.equal(readPreference(store, one), "guided");
  assert.equal(readPreference(store, two), null);
  assert.equal(readPreference(store), null);
  assert.equal(clearPreference(store, two), true);
  assert.equal(readPreference(store, one), "guided", "clearing a sibling's key leaves this one");
  assert.equal(clearPreference(store, one), true);
  assert.equal(readPreference(store, one), null);
});

test("paper says what the printed mode left out, and nothing when it left out nothing", () => {
  assert.equal(printNote("standard", 3), "Printed in Standard mode; 3 supplements not shown.");
  assert.equal(printNote("guided", 1), "Printed in Guided mode; 1 supplement not shown.");
  assert.equal(printNote("deep-dive", 0), "");
});

test("a page's path is the same with or without a trailing index.html", () => {
  assert.equal(pagePath("/post/index.html"), "/post/");
  assert.equal(pagePath("/post/"), "/post/");
  assert.equal(pagePath("/index.html"), "/");
  assert.equal(pagePath("/blog/post/index.html"), "/blog/post/");
  // Only a whole last segment: other files and other names are other pages.
  assert.equal(pagePath("/post/myindex.html"), "/post/myindex.html");
  assert.equal(pagePath("/post/other.html"), "/post/other.html");
  assert.equal(pagePath("/post"), "/post");
  assert.equal(pagePath(undefined), "");
});
