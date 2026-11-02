import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Public copy never claims a reading is true, verified, the consensus or the
// authority (B7, #91). Words of the page text and the component are scanned;
// the rule is about what readers are told, so code identifiers are excluded
// by matching only quoted strings.
const FILES = [
  "crates/openblog-core/src/render/interpretations.rs",
  "web/components/ob-explanation-levels.js",
];
const CLAIMS = /\b(verified|fact[- ]checked|proven|consensus|authoritative|the correct reading|the true reading|definitive)\b/i;

for (const file of FILES) {
  test(`${file} never labels an interpretation as verified truth`, async () => {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    const strings = source.match(/"(?:[^"\\n]|\.)*"/g) ?? [];
    assert.ok(strings.length > 10, "the scan found the copy");
    for (const text of strings) {
      assert.doesNotMatch(text, CLAIMS, `${file}: ${text}`);
    }
  });
}
