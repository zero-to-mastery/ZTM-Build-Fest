// The account backup code's spelling and check (#572): 32 random bytes and a
// 3-byte SHA-256 check as 8 groups of 7 Crockford base32 characters.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_CODE_GROUP_LENGTH,
  BACKUP_CODE_GROUPS,
  formatBackupCode,
  generateBackupCode,
  looksLikeBackupCode,
  normalizeBackupCode,
  parseBackupCode,
} from "./backup-code.js";
import { backupCodeAuthKey, backupCodeKek, backupCodeVerifier } from "./account-vault.js";
import { createHash } from "node:crypto";

const ALPHABET = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

test("a code is 8 groups of 7 unambiguous characters and reads back to its bytes", async () => {
  for (let round = 0; round < 50; round += 1) {
    const { bytes, text } = await generateBackupCode();
    const groups = text.split("-");
    assert.equal(groups.length, BACKUP_CODE_GROUPS);
    assert.ok(groups.every((group) => group.length === BACKUP_CODE_GROUP_LENGTH && ALPHABET.test(group)), text);
    assert.deepEqual(await parseBackupCode(text), bytes);
    assert.equal(await formatBackupCode(bytes), text, "formatting is deterministic");
  }
});

test("known bytes give a known code (a fixed vector for other implementations)", async () => {
  const zero = new Uint8Array(32);
  const text = await formatBackupCode(zero);
  assert.match(text, /^0000000-0000000-0000000-0000000-0000000-0000000-0000000-0[0-9A-Z]{6}$/, "zero bytes, then the check");
  const ones = new Uint8Array(32).fill(0xff);
  assert.match(await formatBackupCode(ones), /^ZZZZZZZ-ZZZZZZZ-ZZZZZZZ-ZZZZZZZ-ZZZZZZZ-ZZZZZZZ-ZZZZZZZ-Z/);
  // The check is SHA-256("kin/backup-code-check/v1" || bytes), first 3 bytes.
  const check = createHash("sha256").update("kin/backup-code-check/v1").update(zero).digest().subarray(0, 3);
  const tail = text.replaceAll("-", "").slice(51);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  // 256 bits of zeros end mid-character: character 51 holds the last bit of
  // the code (0) and the first 4 bits of the check; the last 4 hold 20 bits.
  const bits = [...tail].map((character) => alphabet.indexOf(character).toString(2).padStart(5, "0")).join("").slice(1);
  assert.equal(bits, [...check].map((byte) => byte.toString(2).padStart(8, "0")).join(""));
});

test("typing is forgiving: case, spaces, dashes and look-alike letters", async () => {
  const { bytes, text } = await generateBackupCode();
  const loose = text.toLowerCase().replaceAll("-", "  ").replaceAll("0", "o").replaceAll("1", "l");
  assert.deepEqual(await parseBackupCode(loose), bytes);
  assert.deepEqual(await parseBackupCode(`  ${text.replaceAll("-", "")}\n`), bytes);
  assert.equal(looksLikeBackupCode(loose), true);
  assert.equal(looksLikeBackupCode("a".repeat(64)), false, "a 64-character device backup key isn't a code");
  assert.equal(normalizeBackupCode("U".repeat(56)), null, "U isn't in the alphabet");
  assert.equal(normalizeBackupCode(42), null);
});

test("a typo, a missing group or a swapped pair is caught before anything is sent", async () => {
  const { text } = await generateBackupCode();
  const characters = [...text.replaceAll("-", "")];
  for (const position of [0, 17, 33, 50, 55]) {
    const changed = [...characters];
    changed[position] = changed[position] === "A" ? "B" : "A";
    await assert.rejects(parseBackupCode(changed.join("")), { code: "backup_code_invalid" });
  }
  await assert.rejects(parseBackupCode(text.split("-").slice(1).join("-")), { code: "backup_code_invalid", message: /whole backup code/ });
  const swapped = [...characters];
  const index = swapped.findIndex((value, position) => value !== swapped[position + 1]);
  [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
  await assert.rejects(parseBackupCode(swapped.join("")), { code: "backup_code_invalid", message: /typo/ });
});

test("the code's keys are separate: its wrapper KEK, its sign-in key and the service's check value", async () => {
  const { bytes } = await generateBackupCode();
  const kek = await backupCodeKek(bytes);
  const authKey = await backupCodeAuthKey(bytes);
  assert.notDeepEqual(kek, authKey, "the key sent at sign-in can't open the wrapper");
  const verifier = await backupCodeVerifier(authKey);
  assert.equal(verifier, createHash("sha256").update(authKey).digest().toString("base64url"), "the service compares SHA-256(authKey)");
});
