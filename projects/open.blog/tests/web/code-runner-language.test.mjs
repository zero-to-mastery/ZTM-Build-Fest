import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normalizeCodeRunnerLanguage } from "../../web/components/ob-code-runner-language.js";

test("browser code-runner languages match the shared core contract fixtures", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../fixtures/code-runner-languages.json", import.meta.url), "utf8"));
  for (const { authored, normalized } of fixtures) {
    assert.equal(normalizeCodeRunnerLanguage(authored), normalized, JSON.stringify(authored));
  }
});
