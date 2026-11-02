import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LIMITS,
  MAX_RECENT_TOWNS,
  PREFS_KEY,
  captureBody,
  captureFields,
  captureLimits,
  captureProblem,
  captureSlug,
  captureTitle,
  newCaptureId,
  photoProblem,
  readPrefs,
  rememberPicks,
  sendCapture,
  writePrefs,
} from "../../web/admin/job-capture.js";

const NOW = new Date("2026-10-29T14:05:09.123Z");
const SCAFFOLD = "## Problem\n\n## What we found\n\n## What we did\n\n## Result\n\n";

const memory = (initial) => {
  const map = new Map(initial ? [[PREFS_KEY, initial]] : []);
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map };
};

test("a capture id is 32 lowercase hex digits and never repeats", () => {
  const first = newCaptureId();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.notEqual(first, newCaptureId());
});

test("the limits come from the server's meta and fall back to the defaults", () => {
  assert.deepEqual(captureLimits({}), DEFAULT_LIMITS);
  const limits = captureLimits({ capture: { maxPhotos: 5, maxPhotoBytes: "x", maxNotesChars: -1 } });
  assert.equal(limits.maxPhotos, 5);
  assert.equal(limits.maxPhotoBytes, DEFAULT_LIMITS.maxPhotoBytes);
  assert.equal(limits.maxNotesChars, DEFAULT_LIMITS.maxNotesChars);
});

test("remembered picks survive a round trip, keep the town list short and unique, and ignore anything unreadable", () => {
  let prefs = readPrefs(memory());
  assert.deepEqual(prefs, { trade: "", service: "", towns: [] });
  for (let index = 0; index < MAX_RECENT_TOWNS + 3; index += 1) prefs = rememberPicks(prefs, { trade: "Flooring", service: "hardwood-install", town: `Town ${index}` });
  prefs = rememberPicks(prefs, { trade: "", service: "", town: "town 5" });
  assert.equal(prefs.towns.length, MAX_RECENT_TOWNS);
  assert.equal(prefs.towns[0], "town 5");
  assert.equal(prefs.towns.filter((town) => town.toLowerCase() === "town 5").length, 1);
  assert.equal(prefs.trade, "flooring");
  assert.equal(prefs.service, "hardwood-install");

  const storage = memory();
  writePrefs(storage, prefs);
  assert.deepEqual(readPrefs(storage), prefs);
  for (const bad of ["not json", '{"v":2,"trade":"x"}', "null", '{"v":1,"towns":"nope"}']) {
    const stored = readPrefs(memory(bad));
    assert.deepEqual(stored.towns, []);
  }
  assert.doesNotThrow(() => writePrefs({ setItem() { throw new Error("full"); } }, prefs));
  assert.deepEqual(readPrefs(undefined), { trade: "", service: "", towns: [] });
});

test("a draft's title, slug and fields come from what was picked, and the slug carries the id", () => {
  assert.equal(captureTitle({ trade: "hvac", town: "Springfield" }), "Hvac in Springfield");
  assert.equal(captureTitle({ trade: "mobile-mechanic", town: "" }), "Mobile mechanic job");
  assert.equal(captureTitle({ trade: "", town: "" }, new Date(2026, 9, 29, 12)), "Job notes, 2026-10-29");
  const id = "ab12cd34ef56".padEnd(32, "0");
  assert.equal(captureSlug("Flooring in São Paulo!", id), "flooring-in-s-o-paulo-ab12cd");
  assert.equal(captureSlug("!!!", id), "job-ab12cd");

  const fields = captureFields({ id, fields: { trade: "Flooring", service: " hardwood-install ", town: "Springfield", notes: "x" } }, NOW);
  assert.equal(fields.draft, "true");
  assert.equal(fields.profile, "job");
  assert.equal(fields.date, "2026-10-29T14:05:09Z");
  assert.equal(fields["job.trade"], "flooring");
  assert.equal(fields["job.service"], "hardwood-install");
  assert.equal(fields["job.place.town"], "Springfield");
  assert.equal(fields.slug, "flooring-in-springfield-ab12cd");
  assert.deepEqual(
    Object.keys(captureFields({ id, fields: { trade: "", service: "", town: "", notes: "" } }, NOW)).filter((key) => key.startsWith("job.")).sort(),
    ["job.finished", "job.started"],
  );
});

test("the body puts the notes under the first heading and the photos after the scaffold", () => {
  assert.equal(captureBody({ scaffold: SCAFFOLD }), SCAFFOLD);
  const body = captureBody({ scaffold: SCAFFOLD, notes: " Squeaky floor by the door. ", photoUrls: ["/images/uploads/2026/a.jpg", "/images/uploads/2026/b.jpg"] });
  assert.ok(body.startsWith("## Problem\n\nSqueaky floor by the door.\n\n## What we found"), body);
  assert.ok(body.endsWith("![Photo 1 from the job](/images/uploads/2026/a.jpg)\n\n![Photo 2 from the job](/images/uploads/2026/b.jpg)\n"), body);
  assert.equal(captureBody({ scaffold: "", notes: "Just words" }), "Just words\n\n");
});

test("a capture needs something in it and stays inside its bounds", () => {
  const empty = { id: "x", fields: { notes: "  " }, photos: [], audio: null };
  assert.match(captureProblem(empty), /Add a photo or a few words/);
  assert.equal(captureProblem({ ...empty, fields: { notes: "hello" } }), "");
  const photo = { name: "a.jpg", type: "image/jpeg", size: 10, blob: new Blob(["a"]) };
  assert.match(captureProblem({ ...empty, photos: [photo, photo, photo] }, { ...DEFAULT_LIMITS, maxPhotos: 2 }), /at most 2 photos/);
  assert.match(captureProblem({ ...empty, fields: { notes: "x".repeat(11) } }, { ...DEFAULT_LIMITS, maxNotesChars: 10 }), /at most 10 characters/);
  assert.equal(photoProblem({ name: "a.jpg", type: "image/jpeg", size: 5 }), "");
  assert.match(photoProblem({ name: "a.pdf", type: "application/pdf", size: 5 }), /is not a photo/);
  assert.match(photoProblem({ name: "big.jpg", type: "image/jpeg", size: 11 * 1024 * 1024 }), /larger than 10 MB/);
});

test("sending uploads each photo, skips one the server refuses for good, and creates one draft", async () => {
  const calls = [];
  const api = {
    async call(method, path, options) {
      calls.push({ method, path, options });
      if (path.startsWith("upload?name=bad.jpg")) throw Object.assign(new Error("Only images"), { status: 415 });
      if (path.startsWith("upload")) {
        const query = new URLSearchParams(path.split("?")[1]);
        return { url: `/images/uploads/captures/${query.get("name").replace(/ /g, "-")}` };
      }
      return { path: "posts/2026-10-29-flooring-in-springfield-ab12cd.md" };
    },
  };
  const id = "ab12cd".padEnd(32, "0");
  const photo = (name) => ({ name, type: "image/jpeg", size: 1, blob: new Blob(["x"]) });
  const result = await sendCapture({
    api,
    capture: { id, fields: { trade: "flooring", service: "", town: "Springfield", notes: "Words" }, photos: [photo("a b.jpg"), photo("bad.jpg"), photo("c.jpg")], audio: null },
    scaffold: SCAFFOLD,
    now: NOW,
  });
  assert.deepEqual(result, { path: "posts/2026-10-29-flooring-in-springfield-ab12cd.md", skipped: ["bad.jpg"], audio: "none" });
  assert.equal(calls.filter((call) => call.path.startsWith("upload")).length, 3);
  const slots = calls.filter((call) => call.path.startsWith("upload")).map((call) => new URLSearchParams(call.path.split("?")[1]));
  assert.deepEqual(slots.map((query) => query.get("slot")), ["0", "1", "2"]);
  assert.ok(slots.every((query) => query.get("capture") === id));
  const document = calls.at(-1);
  assert.equal(document.path, "document");
  assert.equal(document.options.json.captureId, id);
  assert.equal(document.options.json.kind, "posts");
  assert.equal(document.options.json.fields.draft, "true");
  assert.match(document.options.json.body, /a-b\.jpg/);
  assert.match(document.options.json.body, /c\.jpg/);
  assert.doesNotMatch(document.options.json.body, /bad\.jpg/);

  const offline = { call: async () => { throw new TypeError("Failed to fetch"); } };
  await assert.rejects(sendCapture({ api: offline, capture: { id, fields: { notes: "x" }, photos: [photo("a.jpg")], audio: null }, scaffold: SCAFFOLD }), TypeError);
});

test("a voice note is sent privately before the draft, never put in the body, and a refused one does not stop the draft", async () => {
  const id = "cd34ef".padEnd(32, "1");
  const note = { type: "audio/webm", size: 4, seconds: 2, blob: new Blob(["abcd"]) };
  const run = async (audioStatus) => {
    const calls = [];
    const api = {
      async call(method, path, options) {
        calls.push({ path, options });
        if (path.startsWith("capture-audio") && audioStatus) throw Object.assign(new Error("no"), { status: audioStatus });
        return { path: "posts/x.md" };
      },
    };
    const result = await sendCapture({ api, capture: { id, fields: { notes: "" }, photos: [], audio: note }, scaffold: SCAFFOLD, now: NOW });
    return { calls, result };
  };
  const kept = await run(0);
  assert.deepEqual(kept.calls.map((call) => call.path), [`capture-audio?capture=${id}`, "document"]);
  assert.equal(kept.calls[0].options.body, note.blob);
  assert.equal(kept.result.audio, "kept");
  assert.doesNotMatch(kept.calls[1].options.json.body, /audio|webm/i);
  assert.equal((await run(415)).result.audio, "refused");
  assert.equal((await run(413)).calls.at(-1).path, "document");
  await assert.rejects(run(503));
  assert.equal(captureProblem({ id, fields: { notes: "" }, photos: [], audio: note }), "", "a voice note alone is a capture");
});
