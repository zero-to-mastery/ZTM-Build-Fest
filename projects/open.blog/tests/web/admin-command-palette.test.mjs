import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");

test("workspace search opens from the header and Ctrl or Command K", () => {
  assert.match(admin, /oba-command-trigger/);
  assert.match(admin, /e\.key\.toLowerCase\(\) === "k"/);
  assert.match(admin, /this\.openCommandPalette\(\)/);
  assert.match(admin, /Search workspace/);
});

test("command palette covers navigation and contextual editor actions", () => {
  for (const label of ["New post", "Posts", "Pages", "Series", "Analytics", "View site", "Switch theme", "Sign out"]) {
    assert.match(admin, new RegExp(`label: "${label}"`));
  }
  assert.match(admin, /label: "Save document"/);
  assert.match(admin, /label: `Show \$\{pane\}`/);
});

test("palette reports filtered results and supports keyboard selection", () => {
  assert.match(admin, /role: "status"/);
  assert.match(admin, /"aria-label": "Command results"/);
  assert.match(admin, /e\.key === "ArrowDown"/);
  assert.match(admin, /e\.key === "ArrowUp"/);
  assert.match(admin, /e\.key === "Enter"/);
  assert.match(styles, /\.oba-command-dialog/);
  assert.match(styles, /\.oba-command-result/);
});

test("workspace navigation protects unsaved editor changes", () => {
  assert.match(admin, /planWorkspaceNavigation\(\{/);
  assert.match(admin, /if \(plan\.confirm\.length && !\(await this\.confirmLeave\(plan\.confirm\)\)\) \{\n\s*history\.replaceState\(null, "", this\.currentHash\);/);
  assert.match(admin, /this\.currentHash = location\.hash/);
});
