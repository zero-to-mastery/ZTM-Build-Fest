// Issue #165: every frozen v1.0 format version is written down in
// docs/V1.0-COMPATIBILITY.md. Changing one in code without updating that
// document (the promise to households) fails this test.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
// A Windows checkout may give the docs CRLF line endings; parse them as LF.
const read = async (path) => (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");

// Where each frozen version lives in the code, and how to read it.
const SOURCES = {
  "replay-protocol": [
    ["rust/src/wire.rs", /pub const PROTOCOL_VERSION: u16 = (\d+);/],
    ["web/wasm/wire.js", /export const PROTOCOL_VERSION = (\d+);/],
  ],
  "error-protocol": [["rust/src/wire.rs", /pub const ERROR_PROTOCOL_VERSION: u16 = (\d+);/]],
  "event-db": [["web/storage/event-store.js", /const DATABASE_VERSION = (\d+);/]],
  "key-db": [["web/sync/key-store.js", /const DATABASE_VERSION = (\d+);/]],
  "encrypted-record": [["web/storage/encrypted-idb.js", /const FORMAT = (\d+);/]],
  "archive-container": [["rust/src/archive.rs", /pub const ARCHIVE_VERSION: u16 = (\d+);/]],
  "export-package": [["web/security/archive.js", /const PACKAGE_FORMAT = (\d+);/]],
  "sync-envelope": [["web/sync/crypto.js", /const ENVELOPE_VERSION = (\d+);/]],
  "sync-protocol": [["web/sync/crypto.js", /const PROTOCOL_VERSION = (\d+);/]],
  "sync-transport": [["web/sync/envelope-wire.js", /view\.setUint16\(4, (\d+), true\);/]],
  "household-settings": [["web/appearance/household.js", /value\.version !== (\d+)/]],
  "server-schema": [["server/durable-store/shared.mjs", /export const SERVER_SCHEMA_VERSION = (\d+);/]],
  "chat-blob": [["web/chat/chat-blob-crypto.js", /const VERSION = (\d+);/]],
  "chat-hidden": [["web/chat/chat-hidden.js", /const VERSION = (\d+);/]],
  "chat-attachment": [["web/chat/chat-attachments.js", /const VERSION = (\d+);/]],
  "chat-receipt": [["web/chat/chat-presence.js", /const SLOT_VERSION = (\d+);/]],
  "account-vault": [["web/security/account-vault.js", /export const VAULT_FORMAT = (\d+);/]],
};

async function frozenVersions() {
  const doc = await read("docs/V1.0-COMPATIBILITY.md");
  const block = /```text frozen-formats\n([\s\S]*?)```/.exec(doc);
  assert.ok(block, "docs/V1.0-COMPATIBILITY.md has a frozen-formats block");
  const versions = new Map();
  for (const line of block[1].split("\n").map((value) => value.trim()).filter(Boolean)) {
    const [name, version, extra] = line.split(/\s+/);
    assert.ok(name && /^\d+$/.test(version ?? "") && extra === undefined, `malformed frozen-formats line: ${line}`);
    assert.ok(!versions.has(name), `duplicate frozen format: ${name}`);
    versions.set(name, Number(version));
  }
  return versions;
}

test("every frozen format in the compatibility document matches the code", async () => {
  const frozen = await frozenVersions();
  assert.deepEqual([...frozen.keys()].sort(), Object.keys(SOURCES).sort(),
    "the document and this test list the same formats");
  for (const [name, sources] of Object.entries(SOURCES)) {
    for (const [path, pattern] of sources) {
      const match = pattern.exec(await read(path));
      assert.ok(match, `${path} no longer declares the ${name} version the way this test expects; update the test`);
      assert.equal(Number(match[1]), frozen.get(name),
        `${name} is ${match[1]} in ${path} but frozen at ${frozen.get(name)} in docs/V1.0-COMPATIBILITY.md. ` +
        "Changing a frozen v1.0 format needs the compatibility document updated in the same change.");
    }
  }
});

test("the table in the compatibility document agrees with the machine-readable block", async () => {
  const doc = await read("docs/V1.0-COMPATIBILITY.md");
  const frozen = await frozenVersions();
  const rows = {
    "replay-protocol": "Replay / WASM request protocol",
    "error-protocol": "WASM error protocol",
    "event-db": "Event IndexedDB schema",
    "key-db": "Key IndexedDB schema",
    "encrypted-record": "Encrypted record format",
    "archive-container": "Portable archive container",
    "export-package": "Export package format",
    "sync-envelope": "Sync event envelope",
    "sync-protocol": "Sync crypto protocol",
    "sync-transport": "Binary sync transport (KSEV/KSEP)",
    "household-settings": "Household settings record",
    "server-schema": "Server database schema",
    "chat-blob": "Chat content blob",
    "chat-hidden": "Chat delete-for-me record",
    "chat-attachment": "Chat attachment manifest",
    "chat-receipt": "Chat receipt slot",
    "account-vault": "Account key vault",
  };
  for (const [name, label] of Object.entries(rows)) {
    const row = doc.split("\n").find((line) => line.startsWith(`| ${label} |`));
    assert.ok(row, `the table has a row for ${label}`);
    const cell = row.split("|")[2].trim();
    assert.match(cell, new RegExp(`(^|\\D)${frozen.get(name)}(\\D|$)`), `${label}: the table says "${cell}" but the frozen version is ${frozen.get(name)}`);
  }
});
