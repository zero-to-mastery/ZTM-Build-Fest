// Username and password rules shared by the browser and the service (#558).
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMON_PASSWORDS,
  normalizeUsername,
  PASSWORD_GUIDANCE,
  passwordProblem,
  usernameProblem,
} from "./account-credentials.js";

test("usernames are case-insensitive, trimmed and NFKC-folded", () => {
  assert.equal(normalizeUsername("Sam.Lee"), "sam.lee");
  assert.equal(normalizeUsername("  sam_lee-2  "), "sam_lee-2");
  // Full-width letters fold to ASCII rather than becoming a second account.
  assert.equal(normalizeUsername("ＳＡＭ"), "sam");
  assert.equal(normalizeUsername("SAM"), normalizeUsername("sam"));
});

test("usernames are 3 to 32 letters, digits, dots, dashes or underscores", () => {
  for (const bad of ["", "ab", "a".repeat(33), "sam lee", "sam@home", "sámi", "сам", "sam/lee", null, 42, undefined])
    assert.equal(normalizeUsername(bad), null, String(bad));
  assert.equal(normalizeUsername("abc"), "abc");
  assert.equal(normalizeUsername("a".repeat(32)), "a".repeat(32));
  assert.equal(usernameProblem("sam"), null);
  assert.match(usernameProblem("s"), /3 to 32 letters, numbers, dots, dashes or underscores/);
});

test("the password floor: 10 characters, not common, not repeated, not the username", () => {
  assert.equal(passwordProblem("correct horse battery"), null);
  assert.equal(passwordProblem("short pass"), null, "ten characters, including the space");
  assert.equal(passwordProblem("short"), PASSWORD_GUIDANCE);
  assert.equal(passwordProblem(""), "Enter a password.");
  // Code points, not UTF-16 units: five emoji are five characters.
  assert.equal(passwordProblem("🔑🔑🏠🏠🌳"), PASSWORD_GUIDANCE);
  for (const common of ["1234567890", "Password123", "QWERTYUIOP", "iloveyou123"])
    assert.match(passwordProblem(common), /too easy to guess/, common);
  assert.match(passwordProblem("aaaaaaaaaaaa"), /too easy to guess/);
  assert.match(passwordProblem("sam.lee.home", { username: "Sam.Lee.Home" }), /too easy to guess/);
  assert.equal(passwordProblem("sam.lee.home", { username: "someone" }), null);
  assert.match(passwordProblem("x".repeat(1025)), /too long/);
});

test("the common list is about 200 entries, lower-case, all at least 10 characters", () => {
  assert.ok(COMMON_PASSWORDS.size >= 190 && COMMON_PASSWORDS.size <= 260, String(COMMON_PASSWORDS.size));
  for (const entry of COMMON_PASSWORDS) {
    assert.equal(entry, entry.toLowerCase());
    assert.ok([...entry].length >= 10, entry);
  }
});
