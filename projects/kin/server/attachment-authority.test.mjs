// Issue #156 (A3): only the uploader or an Adult can delete encrypted
// attachment bytes, deletions are audited, and attachments stored before the
// uploader was recorded are Adult-only. Covers the in-memory relay and the
// durable SQLite store, including the schema 8 -> 9 migration.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { SERVER_SCHEMA_VERSION, sqlitePragma } from "./durable-store/shared.mjs";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

function admit(pairing, adult, kind, suffix) {
  const invitation = pairing.createPairing(adult.sessionToken, { kind });
  const claim = pairing.claimPairing({ code: invitation.code, credential: credential(suffix), deviceLabel: suffix });
  pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const member = pairing.activateClaim(claim.claimToken);
  pairing.devices.get(member.deviceId).syncProvisionedEpochs = [1];
  return member;
}

function household({ durable }) {
  const store = durable ? new DurableStore(":memory:") : null;
  const pairing = new PairingService({ store });
  const founder = pairing.bootstrap({ credential: credential("founder"), deviceLabel: "Founder" });
  const sync = new EncryptedSyncService(pairing, { store });
  sync.enable(founder.sessionToken);
  const adult = admit(pairing, founder, "adult", "adult");
  const limited = admit(pairing, founder, "limited", "limited");
  const otherLimited = admit(pairing, founder, "limited", "other-limited");
  let next = 0;
  const upload = (member) => {
    next += 1;
    const attachmentId = next.toString(16).padStart(2, "0").repeat(16);
    const ciphertext = Buffer.alloc(64, next);
    sync.pushAttachment(member.sessionToken, { attachmentId, keyEpoch: 1, ciphertext, digest: createHash("sha256").update(ciphertext).digest("hex") });
    return attachmentId;
  };
  const exists = (attachmentId) => sync.listAttachments(founder.sessionToken).some((row) => row.attachmentId === attachmentId);
  return { store, pairing, sync, founder, adult, limited, otherLimited, upload, exists, close: () => store?.close() };
}

const forbidden = (error) => error.code === "attachment_delete_forbidden" && error.status === 403;

for (const durable of [false, true]) {
  const label = durable ? "durable" : "in-memory";

  test(`${label}: a Limited member cannot delete someone else's attachment`, () => {
    const h = household({ durable });
    try {
      const founders = h.upload(h.founder);
      const others = h.upload(h.otherLimited);
      for (const attachmentId of [founders, others]) {
        assert.throws(() => h.sync.removeAttachment(h.limited.sessionToken, attachmentId), forbidden);
        assert.equal(h.exists(attachmentId), true, "the attachment is unchanged");
      }
      assert.equal(h.pairing.events.some((event) => event.type === "attachment_deleted"), false);
    } finally { h.close(); }
  });

  test(`${label}: an uploader can delete their own attachment, and it is audited`, () => {
    const h = household({ durable });
    try {
      const attachmentId = h.upload(h.limited);
      assert.deepEqual(h.sync.removeAttachment(h.limited.sessionToken, attachmentId), { removed: true });
      assert.equal(h.exists(attachmentId), false);
      const audit = h.pairing.events.find((event) => event.type === "attachment_deleted");
      assert.equal(audit.attachmentId, attachmentId);
      assert.equal(audit.memberId, h.limited.memberId);
      assert.equal(audit.deviceId, h.limited.deviceId);
      assert.equal(typeof audit.at, "number");
    } finally { h.close(); }
  });

  test(`${label}: any Adult can delete anyone's attachment`, () => {
    const h = household({ durable });
    try {
      const fromLimited = h.upload(h.limited);
      const fromFounder = h.upload(h.founder);
      assert.deepEqual(h.sync.removeAttachment(h.adult.sessionToken, fromLimited), { removed: true });
      assert.deepEqual(h.sync.removeAttachment(h.adult.sessionToken, fromFounder), { removed: true });
      assert.equal(h.exists(fromLimited), false);
      assert.equal(h.exists(fromFounder), false);
    } finally { h.close(); }
  });

  test(`${label}: deleting an attachment that is already gone still succeeds`, () => {
    const h = household({ durable });
    try {
      assert.deepEqual(h.sync.removeAttachment(h.limited.sessionToken, "f".repeat(32)), { removed: true });
    } finally { h.close(); }
  });
}

test("durable: an attachment stored before uploaders were recorded is Adult-only", () => {
  const h = household({ durable: true });
  try {
    const attachmentId = h.upload(h.limited);
    // A row written by the schema 8 server has no uploader.
    h.store.db.prepare("UPDATE sync_attachments SET uploader_member_id = NULL WHERE attachment_id = ?").run(attachmentId);
    assert.throws(() => h.sync.removeAttachment(h.limited.sessionToken, attachmentId), forbidden);
    assert.equal(h.exists(attachmentId), true);
    assert.deepEqual(h.sync.removeAttachment(h.adult.sessionToken, attachmentId), { removed: true });
  } finally { h.close(); }
});

test("durable: schema 9 adds a nullable uploader column", () => {
  const store = new DurableStore(":memory:");
  try {
    assert.ok(SERVER_SCHEMA_VERSION >= 9);
    assert.equal(sqlitePragma(store.db, "user_version", { simple: true }), SERVER_SCHEMA_VERSION);
    const column = store.db.prepare("PRAGMA table_info(sync_attachments)").all().find((row) => row.name === "uploader_member_id");
    assert.ok(column, "uploader_member_id exists");
    assert.equal(column.notnull, 0);
  } finally { store.close(); }
});

test("durable: the deletion audit survives a restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "kin-attachment-audit-"));
  const path = join(directory, "kin.sqlite");
  try {
    const store = new DurableStore(path);
    const pairing = new PairingService({ store });
    const founder = pairing.bootstrap({ credential: credential("founder"), deviceLabel: "Founder" });
    const sync = new EncryptedSyncService(pairing, { store });
    sync.enable(founder.sessionToken);
    const attachmentId = "ab".repeat(16);
    const ciphertext = Buffer.alloc(64, 9);
    sync.pushAttachment(founder.sessionToken, { attachmentId, keyEpoch: 1, ciphertext, digest: createHash("sha256").update(ciphertext).digest("hex") });
    sync.removeAttachment(founder.sessionToken, attachmentId);
    store.close();
    const reopened = new DurableStore(path);
    try {
      const rows = reopened.db.prepare("SELECT * FROM security_audit").all()
        .filter((row) => JSON.stringify(row).includes("attachment_deleted"));
      assert.equal(rows.length, 1);
      assert.match(JSON.stringify(rows[0]), new RegExp(attachmentId));
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
