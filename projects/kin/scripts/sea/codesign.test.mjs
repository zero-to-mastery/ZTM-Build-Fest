// Kin's ad-hoc code signature (scripts/sea/codesign.mjs, #747): the
// SuperBlob layout from cs_blobs.h, page hashes the kernel would accept, and
// rejection of any changed byte.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { adHocSignature, adHocSignatureSize, CodeSignatureError, CS_ADHOC, CSMAGIC_BLOBWRAPPER, CSMAGIC_REQUIREMENTS, CSSLOT_REQUIREMENTS, CSSLOT_SIGNATURESLOT, readCodeSignature, verifyAdHocSignature } from "./codesign.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

// A file of 2.5 pages of code followed by its signature.
function signed(codeLimit = 4096 * 2 + 2048) {
  const size = adHocSignatureSize(codeLimit, "io.example.kin");
  const file = Buffer.alloc(codeLimit + size);
  for (let index = 0; index < codeLimit; index += 1) file[index] = (index * 31) & 0xff;
  const signature = adHocSignature(file, { codeLimit, identifier: "io.example.kin", execSegBase: 0, execSegLimit: 4096 });
  assert.equal(signature.length, size, "adHocSignatureSize predicts the size");
  signature.copy(file, codeLimit);
  return { file, codeLimit };
}

test("the signature is a SuperBlob with a CodeDirectory, empty requirements and an empty CMS wrapper", { timeout: 60_000 }, () => {
  const { file, codeLimit } = signed();
  const { slots, codeDirectory: cd } = readCodeSignature(file.subarray(codeLimit));
  assert.deepEqual([...slots.keys()], [0, CSSLOT_REQUIREMENTS, CSSLOT_SIGNATURESLOT]);
  assert.equal(slots.get(CSSLOT_REQUIREMENTS).readUInt32BE(0), CSMAGIC_REQUIREMENTS);
  assert.equal(slots.get(CSSLOT_REQUIREMENTS).length, 12);
  assert.equal(slots.get(CSSLOT_SIGNATURESLOT).readUInt32BE(0), CSMAGIC_BLOBWRAPPER);
  assert.equal(slots.get(CSSLOT_SIGNATURESLOT).length, 8);
  assert.equal(cd.version, 0x20400);
  assert.equal(cd.flags, CS_ADHOC);
  assert.equal(cd.identifier, "io.example.kin");
  assert.equal(cd.teamOffset, 0, "no team");
  assert.equal(cd.pageSize, 4096);
  assert.equal(cd.codeLimit, codeLimit);
  assert.equal(cd.nCodeSlots, 3);
  assert.equal(cd.nSpecialSlots, 2);
  assert.equal(cd.execSegLimit, 4096n);
  assert.equal(cd.execSegFlags, 1n, "CS_EXECSEG_MAIN_BINARY");
  // The last, short page is hashed as it is, not padded.
  assert.deepEqual(cd.bytes.subarray(cd.hashOffset + 64, cd.hashOffset + 96), sha256(file.subarray(8192, codeLimit)));
  // Slot -1 (Info.plist) is empty; slot -2 is the requirements' hash.
  assert.ok(cd.bytes.subarray(cd.hashOffset - 32, cd.hashOffset).every((byte) => byte === 0));
  assert.deepEqual(cd.bytes.subarray(cd.hashOffset - 64, cd.hashOffset - 32), sha256(slots.get(CSSLOT_REQUIREMENTS)));
  verifyAdHocSignature(file, codeLimit);
});

test("any changed byte under the code limit fails verification, naming the page", { timeout: 60_000 }, () => {
  for (const at of [0, 4095, 4096, 9000]) {
    const { file, codeLimit } = signed();
    file[at] ^= 1;
    assert.throws(() => verifyAdHocSignature(file, codeLimit), (error) => error instanceof CodeSignatureError && new RegExp(`Page ${Math.floor(at / 4096)} `).test(error.message), `byte ${at}`);
  }
  const { file, codeLimit } = signed();
  assert.throws(() => verifyAdHocSignature(file, codeLimit - 16), /isn't an embedded code signature|code limit/);
  const requirements = Buffer.from(file);
  requirements[requirements.length - 8 - 1] ^= 1; // inside the requirements blob's count
  assert.throws(() => verifyAdHocSignature(requirements, codeLimit), /requirements/);
});

test("signing is deterministic and refuses bad inputs", { timeout: 60_000 }, () => {
  const file = Buffer.alloc(5000, 1);
  const options = { codeLimit: 5000, identifier: "kin", execSegBase: 0, execSegLimit: 4096 };
  assert.deepEqual(adHocSignature(file, options), adHocSignature(Buffer.from(file), options));
  assert.throws(() => adHocSignature(file, { ...options, codeLimit: 6000 }), /outside the file/);
  assert.throws(() => adHocSignature(file, { ...options, identifier: "a b" }), /plain ASCII/);
  assert.throws(() => readCodeSignature(Buffer.from("not a signature")), /isn't an embedded code signature/);
});
