import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROVIDER_SCRIPT } from "../../web/components/comment-captcha.js";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// Audit result for #311: the site ships no Content-Security-Policy of its own, so there is no
// allowance to add. If one is ever added, it must name only the provider's origin and only
// when captcha is on; this test makes that change deliberate.
test("netlify.toml publishes no Content-Security-Policy, so no provider allowance is needed", () => {
  assert.doesNotMatch(read("netlify.toml"), /content-security-policy/i);
});

test("the only third-party origin the comment component can reach is the provider's", () => {
  assert.equal(new URL(PROVIDER_SCRIPT).origin, "https://challenges.cloudflare.com");
  const origins = new Set();
  for (const file of ["web/components/comment-captcha.js", "web/components/ob-comments.js"]) {
    for (const match of read(file).matchAll(/https?:\/\/[^\s"'`)]+/g)) origins.add(new URL(match[0]).origin);
  }
  assert.deepEqual([...origins], ["https://challenges.cloudflare.com"]);
});

test("the setup guide tells owners with their own policy to allow exactly that origin", () => {
  const guide = read("netlify/functions/README.md");
  assert.match(guide, /script-src/);
  assert.match(guide, /frame-src/);
  assert.match(guide, /https:\/\/challenges\.cloudflare\.com/);
  assert.doesNotMatch(guide, /(?:script|frame|connect)-src[^\n]*\*/);
});
