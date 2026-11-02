// Photos and files in chat (#114): the limits and their plain messages, file
// names and types made safe to show, the manifest's format and checks, and
// photo metadata removal (the browser's canvas is stood in for here; the
// real one runs in the browser regression).
import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTACHMENT_PART_BYTES, ChatAttachmentError, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FILES, attachmentProblem, decodeManifest,
  encodeManifest, manifestRefs, preparePhoto, safeAttachmentName, safeAttachmentType, voiceProblem,
} from "./chat-attachments.js";

const ref = (n) => n.toString(16).padStart(64, "0");
const key = (n) => (n + 1).toString(16).padStart(64, "0");
const part = (n, size = ATTACHMENT_PART_BYTES) => ({ ref: ref(n), key: key(n), size });
const file = (name, type, size) => new File([new Uint8Array(size)], name, { type });

test("attachments are checked with plain, specific messages", () => {
  assert.match(attachmentProblem([]), /Choose a photo or file/);
  assert.match(attachmentProblem(Array.from({ length: MAX_ATTACHMENT_FILES + 1 }, () => file("a.txt", "text/plain", 1))), /up to 10 files/);
  assert.match(attachmentProblem([file("empty.pdf", "application/pdf", 0)]), /empty\. Choose a file that has content/);
  assert.match(attachmentProblem([file("big.pdf", "application/pdf", MAX_ATTACHMENT_BYTES + 1)]), /big\.pdf is 25\.0 MB\. Files can be 25 MB or smaller/);
  assert.match(attachmentProblem([file("scan.heic", "image/heic", 10)]), /can't be sent as a photo.*JPEG, PNG and WebP/s);
  assert.equal(attachmentProblem([file("receipt.pdf", "application/pdf", MAX_ATTACHMENT_BYTES)]), null, "the limit itself is allowed");
  assert.equal(attachmentProblem([file("notes.bin", "", 3)]), null, "any other file type goes as a file");
});

test("names are text: no folders, no control or bidi characters, bounded", () => {
  assert.equal(safeAttachmentName("C:\\Users\\me\\..\\receipt.pdf"), "receipt.pdf");
  assert.equal(safeAttachmentName("../../etc/passwd"), "passwd");
  assert.equal(safeAttachmentName("a\u0000b\u202ec.txt"), "abc.txt");
  assert.equal(safeAttachmentName("  spaced \t\n name  "), "spaced name");
  assert.equal(safeAttachmentName(""), "Attachment");
  assert.equal(safeAttachmentName(undefined), "Attachment");
  assert.equal([...safeAttachmentName("é".repeat(500))].length, 200);
  assert.equal(safeAttachmentName("🧾 receipt 🧾.pdf"), "🧾 receipt 🧾.pdf", "emoji are kept as text");
});

test("types are well-formed MIME types, else generic", () => {
  assert.equal(safeAttachmentType("Application/PDF"), "application/pdf");
  assert.equal(safeAttachmentType("text/plain; charset=utf-8"), "application/octet-stream");
  assert.equal(safeAttachmentType("<script>"), "application/octet-stream");
  assert.equal(safeAttachmentType(""), "application/octet-stream");
});

test("a manifest round-trips and names every part", () => {
  const big = { name: "Permission slip.pdf", type: "application/pdf", size: ATTACHMENT_PART_BYTES * 2 + 5, thumbnail: null,
    parts: [part(1), part(2), part(3, 5)] };
  const photo = { name: "Milk list.jpg", type: "image/jpeg", size: 9, thumbnail: part(5, 4), parts: [part(4, 9)] };
  const bytes = encodeManifest({ text: "Sign by Friday 🖊️", files: [big, photo] });
  const manifest = decodeManifest(bytes);
  assert.equal(manifest.text, "Sign by Friday 🖊️");
  assert.deepEqual(manifest.files.map((entry) => [entry.name, entry.size, entry.parts.length, Boolean(entry.thumbnail)]),
    [["Permission slip.pdf", big.size, 3, false], ["Milk list.jpg", 9, 1, true]]);
  assert.deepEqual(manifestRefs(manifest), [ref(1), ref(2), ref(3), ref(4), ref(5)], "parts and thumbnails, in order");
});

test("a manifest with a bad shape, size or reference is refused", () => {
  const good = { name: "a.pdf", type: "application/pdf", size: ATTACHMENT_PART_BYTES + 1, thumbnail: null, parts: [part(1), part(2, 1)] };
  const cases = {
    "not JSON": new TextEncoder().encode("{"),
    "wrong version": new TextEncoder().encode(JSON.stringify({ version: 2, text: "", files: [good] })),
    "no files": new TextEncoder().encode(JSON.stringify({ version: 1, text: "", files: [] })),
    "a caption over 4000 characters": new TextEncoder().encode(JSON.stringify({ version: 1, text: "x".repeat(4001), files: [good] })),
    "parts that don't add up": encodeRaw({ ...good, size: 7 }),
    "a short part in the middle": encodeRaw({ ...good, size: ATTACHMENT_PART_BYTES * 2, parts: [part(1, 10), part(2)] }),
    "a part of the wrong count": encodeRaw({ ...good, parts: [part(1)] }),
    "a bad reference": encodeRaw({ ...good, parts: [{ ref: "xyz", key: key(1), size: ATTACHMENT_PART_BYTES }, part(2, 1)] }),
    "a bad key": encodeRaw({ ...good, parts: [{ ref: ref(1), key: "../etc", size: ATTACHMENT_PART_BYTES }, part(2, 1)] }),
    "a file over the limit": encodeRaw({ ...good, size: MAX_ATTACHMENT_BYTES + 1 }),
    "a thumbnail on a file, not a photo": encodeRaw({ ...good, thumbnail: part(9, 3) }),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    assert.throws(() => decodeManifest(bytes), (error) => error instanceof ChatAttachmentError && error.code === "chat_attachment_invalid", label);
  }
  assert.throws(() => decodeManifest(new Uint8Array(256 * 1024 + 1)), ChatAttachmentError, "oversized");
});

function encodeRaw(entry) {
  return new TextEncoder().encode(JSON.stringify({ version: 1, text: "", files: [entry] }));
}

test("a photo is drawn again, so its metadata doesn't survive, and a thumbnail is made", async () => {
  const drawn = [];
  const canvas = (width, height) => ({
    width, height,
    getContext: () => ({ drawImage: (source, ...rest) => drawn.push({ width, height, source: source.name, rest }), fillStyle: "", fillRect() {} }),
    convertToBlob: async ({ type, quality }) => {
      drawn.push({ encode: type, quality });
      return new Blob([new Uint8Array(width * height / 1000)], { type });
    },
  });
  const photo = new File([new Uint8Array(100)], "IMG_2041.jpg", { type: "image/jpeg" });
  const decode = async (blob) => ({ name: blob.name, width: 4000, height: 3000, close() { drawn.push({ closed: true }); } });
  const result = await preparePhoto(photo, { decode, makeCanvas: canvas });
  assert.equal(result.blob.type, "image/jpeg");
  assert.ok(drawn.some((entry) => entry.encode === "image/jpeg" && entry.quality === 0.92), "re-encoded as a fresh JPEG");
  const thumb = drawn.filter((entry) => entry.encode === "image/jpeg").at(-1);
  assert.equal(thumb.quality, 0.8);
  assert.equal(result.thumbnail.type, "image/jpeg");
  assert.ok(drawn.some((entry) => entry.closed), "the decoded bitmap is released");
  assert.deepEqual(drawn.find((entry) => entry.rest?.length === 4)?.rest, [0, 0, 320, 240], "the thumbnail is 320 pixels on its long edge");
});

test("a photo the browser can't read, or can't draw again as its own type, is refused", async () => {
  const photo = new File([new Uint8Array(4)], "scan.png", { type: "image/png" });
  await assert.rejects(preparePhoto(photo, { decode: async () => { throw new Error("nope"); }, makeCanvas: () => null }),
    (error) => error.code === "chat_attachment_invalid" && /couldn't read scan\.png/.test(error.message));
  const huge = await preparePhoto(photo, { decode: async () => ({ width: 9000, height: 9000, close() {} }), makeCanvas: () => null }).catch((error) => error);
  assert.match(huge.message, /under 40 megapixels/);
  const noPng = { getContext: () => ({ drawImage() {}, fillRect() {} }), convertToBlob: async () => new Blob([new Uint8Array(3)], { type: "image/png" }) };
  const webp = new File([new Uint8Array(4)], "a.webp", { type: "image/webp" });
  await assert.rejects(preparePhoto(webp, { decode: async () => ({ width: 10, height: 10, close() {} }), makeCanvas: () => noPng }),
    /can't prepare that photo.*JPEG/);
});

test("a photo is recognized by its bytes, whatever it claims to be", async () => {
  const { sniffPhotoType } = await import("./chat-attachments.js");
  const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0])], "a", { type: "" });
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])], "b", { type: "application/octet-stream" });
  const webp = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])], "c");
  const text = new File([new TextEncoder().encode("hello world")], "d.txt", { type: "image/jpeg" });
  assert.equal(await sniffPhotoType(jpeg), "image/jpeg");
  assert.equal(await sniffPhotoType(png), "image/png");
  assert.equal(await sniffPhotoType(webp), "image/webp");
  assert.equal(await sniffPhotoType(text), null);
});

test("a decoded manifest's names and types are plain text, and a non-photo's type is generic when odd", () => {
  const bytes = encodeManifest({ text: "", files: [{ name: "x‮f.pdf", type: "text/html; evil", size: 3, thumbnail: null, parts: [part(1, 3)] }] });
  const [file] = decodeManifest(bytes).files;
  assert.equal(file.name, "xf.pdf");
  assert.equal(file.type, "application/octet-stream");
});

test("a voice message keeps its length and waveform, and only an audio file alone may carry them (#134)", () => {
  const peaks = Array.from({ length: 64 }, (_, index) => index * 4);
  const voice = { durationMs: 42_000, peaks };
  const note = { name: "Voice message.webm", type: "audio/webm", size: 10, thumbnail: null, parts: [part(1, 10)], voice };
  const manifest = decodeManifest(encodeManifest({ text: "", files: [note] }));
  assert.deepEqual(manifest.files[0].voice, voice);
  assert.equal(decodeManifest(encodeManifest({ text: "", files: [{ ...note, voice: undefined }] })).files[0].voice, null, "a plain audio file has none");
  assert.equal(voiceProblem(voice), null);
  assert.match(voiceProblem({ ...voice, durationMs: 301_001 }), /5 minutes/);
  assert.match(voiceProblem({ ...voice, durationMs: 0 }), /5 minutes/);
  assert.match(voiceProblem({ ...voice, peaks: peaks.slice(1) }), /waveform/);
  assert.match(voiceProblem({ ...voice, peaks: [...peaks.slice(1), 256] }), /waveform/);
  assert.match(voiceProblem({ ...voice, peaks: [...peaks.slice(1), 1.5] }), /waveform/);
  assert.ok(voiceProblem(null) && voiceProblem([]));
  const bad = {
    "a type that isn't audio": { ...note, type: "application/pdf" },
    "too long": { ...note, voice: { ...voice, durationMs: 400_000 } },
    "the wrong number of peaks": { ...note, voice: { ...voice, peaks: [1, 2] } },
    "a peak out of range": { ...note, voice: { ...voice, peaks: [...peaks.slice(1), 300] } },
  };
  for (const [label, entry] of Object.entries(bad))
    assert.throws(() => decodeManifest(encodeRaw(entry)), ChatAttachmentError, label);
  assert.throws(() => decodeManifest(new TextEncoder().encode(JSON.stringify({ version: 1, text: "", files: [note, { ...note, parts: [part(2, 10)] }] }))), ChatAttachmentError, "with other files");
});
