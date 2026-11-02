// A ratchet on fixed sleeps in the browser suites (#327). "Sleep, then
// check" races a busy runner: the drills should wait for the state they check
// instead. Each suite may keep at most the sleeps it had when this was added;
// when you replace one with a wait on real state, lower its number here.
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";

const FIXED_SLEEP = /setTimeout\((?:resolve|done|r), *[0-9]{2,}\)|await delay\([0-9]{2,}\)/g;

// Counted in October 2026 (173 in all).
const ALLOWED = {
  "attachment-upload-regression.mjs": 12,
  "browser-regression.mjs": 21,
  "bulk-actions-regression.mjs": 4,
  "catch-up-regression.mjs": 2,
  "chat-regression.mjs": 16,
  "daily-ux-hardening-regression.mjs": 4,
  "fridge-regression.mjs": 4,
  "handoff-regression.mjs": 6,
  "household-authority-regression.mjs": 44,
  "keyboard-commands-regression.mjs": 7,
  "mobile-ux-regression.mjs": 2,
  "passkey-regression.mjs": 7,
  "planning-date-regression.mjs": 1,
  "pulse-regression.mjs": 2,
  "qr-regression.mjs": 1,
  "quick-add-regression.mjs": 1,
  "recurring-tasks-regression.mjs": 1,
  "root-rotation-ui-regression.mjs": 1,
  "routine-regression.mjs": 2,
  "security-household-regression.mjs": 1,
  "security-key-regression.mjs": 1,
  "security-storage-regression.mjs": 4,
  "security-ui-regression.mjs": 6,
  "shopping-regression.mjs": 1,
  "talk-regression.mjs": 1,
  "today-actionable-regression.mjs": 5,
  "workspace-ux-regression.mjs": 14,
};

test("browser suites don't gain fixed sleeps", async () => {
  const scripts = new URL("./", import.meta.url);
  const files = (await readdir(scripts)).filter((name) => name.endsWith("-regression.mjs")).sort();
  const grown = [];
  for (const name of files) {
    const count = ((await readFile(new URL(name, scripts), "utf8")).match(FIXED_SLEEP) ?? []).length;
    const allowed = ALLOWED[name] ?? 0;
    if (count > allowed) grown.push(`${name}: ${count} fixed sleeps (at most ${allowed}); wait for the state you check instead`);
  }
  assert.deepEqual(grown, []);
});
