import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PROJECT_ROOT } from "./verify.mjs";

const docs = join(PROJECT_ROOT, "docs");

async function readDoc(name) {
  // A Windows checkout may give the docs CRLF line endings; parse them as LF.
  return (await readFile(join(docs, name), "utf8")).replace(/\r\n/g, "\n");
}

test("identity choices keep separate member and device outcomes", async () => {
  const acceptance = await readDoc("IDENTITY-PAIRING-ACCEPTANCE.md");

  assert.match(acceptance, /Invite another person[\s\S]*creates one new member ID/i);
  assert.match(acceptance, /never silently switches paths/i);
  assert.match(acceptance, /Add my device[\s\S]*keeps the same member ID/i);
  assert.match(acceptance, /preferred name[\s\S]*presentation only/i);
  assert.match(acceptance, /device (?:label|name)[\s\S]*(?:not proof|does not prove).*authority/i);
});

test("the acceptance matrix covers every required platform and migration path", async () => {
  const acceptance = await readDoc("IDENTITY-PAIRING-ACCEPTANCE.md");
  const requiredRows = [
    "Two members",
    "One member, multiple devices",
    "QR invitation",
    "Manual invitation",
    "QR same-member pairing",
    "Manual same-member pairing",
    "iOS installed PWA",
    "Android",
    "Desktop",
    "Offline",
    "Rename propagation",
    "Accessibility",
    "Localization readiness",
    "Existing-member migration",
  ];

  for (const row of requiredRows) {
    assert.match(acceptance, new RegExp(`\\|\\s*${row.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\|`, "i"));
  }

  assert.match(acceptance, /## What CI cannot verify/);
  assert.match(acceptance, /physical iOS/i);
  assert.match(acceptance, /physical Android/i);
  assert.match(acceptance, /VoiceOver/i);
});

test("localization acceptance avoids assembling English-specific identity copy", async () => {
  const acceptance = await readDoc("IDENTITY-PAIRING-ACCEPTANCE.md");
  assert.match(acceptance, /complete non-concatenated sentences/i);
  assert.match(acceptance, /text expansion and wrapping/i);
  assert.match(acceptance, /without English possessive construction/i);
  assert.match(acceptance, /no logic compares translated copy/i);
  assert.match(acceptance, /pseudolocale/i);
});

test("identity guidance is linked from every affected contract", async () => {
  for (const name of ["UX.md", "IDENTITY.md", "PAIRING.md", "PRIVACY.md", "PUSH.md", "TESTING.md", "ACCESSIBILITY.md"]) {
    assert.match(await readDoc(name), /IDENTITY-PAIRING-ACCEPTANCE\.md/, `${name} must link the shared acceptance contract`);
  }
});

test("notification guidance preserves author filtering and device-local controls", async () => {
  const acceptance = await readDoc("IDENTITY-PAIRING-ACCEPTANCE.md");
  assert.match(acceptance, /other active members/i);
  assert.match(acceptance, /same member(?:'s)? devices/i);
  assert.match(acceptance, /per-device opt-in/i);
  assert.match(acceptance, /no direct-send/i);
  assert.match(acceptance, /no read receipt/i);
  assert.match(acceptance, /no presence/i);
});

test("identity presentation does not weaken security or privacy authority", async () => {
  const acceptance = await readDoc("IDENTITY-PAIRING-ACCEPTANCE.md");
  assert.match(acceptance, /stable member ID remains authoritative/i);
  assert.match(acceptance, /encrypted\s+household\s+events?/i);
  assert.match(acceptance, /notification filtering/i);
  assert.match(acceptance, /no regression/i);
});
