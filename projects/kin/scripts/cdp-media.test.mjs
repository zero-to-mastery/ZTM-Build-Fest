// Issue #795: browser checks set the colour scheme they measure instead of
// reading the machine's.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mediaFeatures, setMedia } from "./cdp-media.mjs";

const fakeClient = () => {
  const sent = [];
  return { sent, async send(method, params) { sent.push([method, params]); } };
};

test("setMedia with nothing asked for sends the light baseline", async () => {
  const client = fakeClient();
  await setMedia(client);
  assert.deepEqual(client.sent, [["Emulation.setEmulatedMedia", { media: "", features: [
    { name: "prefers-color-scheme", value: "light" },
    { name: "forced-colors", value: "none" },
  ] }]]);
});

test("a requested feature replaces its baseline value and keeps the others", () => {
  assert.deepEqual(mediaFeatures([{ name: "forced-colors", value: "active" }, { name: "prefers-reduced-motion", value: "reduce" }]), [
    { name: "prefers-color-scheme", value: "light" },
    { name: "forced-colors", value: "active" },
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  assert.deepEqual(mediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]), [
    { name: "prefers-color-scheme", value: "dark" },
    { name: "forced-colors", value: "none" },
  ]);
});

test("setMedia passes a media type with the baseline features", async () => {
  const client = fakeClient();
  await setMedia(client, [], { media: "print" });
  assert.equal(client.sent[0][1].media, "print");
  assert.equal(client.sent[0][1].features.length, 2);
});

test("the workspace screenshots start light before the first page loads", async () => {
  const source = await readFile(new URL("./workspace-screenshots.mjs", import.meta.url), "utf8");
  const firstNavigate = source.indexOf('"Page.navigate"');
  assert.ok(firstNavigate > 0);
  assert.match(source.slice(0, firstNavigate), /await setMedia\(client\);/);
});
