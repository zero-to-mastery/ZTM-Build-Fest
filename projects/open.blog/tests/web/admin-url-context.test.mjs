import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const admin = fs.readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");

test("URL context requires confirmation then keeps retrieval, inspection, and save separate", () => {
  assert.match(admin, /confirm\(`Retrieve \$\{url\} as untrusted reference context\?`\)/);
  assert.match(admin, /api\.call\("POST", "assistant\/context\/url\/retrieve"/);
  assert.match(admin, /Inspect the retrieved text before saving/);
  assert.match(admin, /snapshot\.sourceUrl/);
  assert.match(admin, /snapshot\.canonicalUrl/);
  assert.match(admin, /snapshot\.retrievedAt/);
  assert.match(admin, /snapshot\.contentType/);
  assert.match(admin, /api\.call\("POST", "assistant\/context\/url\/save"/);
  assert.match(admin, /confirmed: true, visibility, fileId, snapshot/);
});

test("saved URL context is selected from the catalog without an implicit refetch", () => {
  assert.match(admin, /this\.assistantContextSelected\.add\(saved\.id\)/);
  assert.match(admin, /await this\.loadAssistantContext\(true\)/);
  assert.doesNotMatch(admin, /api\.call\("GET", "assistant\/context\/url\/retrieve"/);
});
