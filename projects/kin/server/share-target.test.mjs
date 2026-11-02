// Sharing into Kin (#389): the manifest offers the share target, and a share
// that reaches the server (no service worker yet) is not read or kept: the app
// just opens.
import assert from "node:assert/strict";
import test from "node:test";
import { PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

async function start(t) {
  const app = createKinServer({ service: new PairingService(), acquireProcessLock: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return `http://127.0.0.1:${app.server.address().port}`;
}

test("the manifest offers sharing into Kin and the shortcuts", async (t) => {
  const url = await start(t);
  const manifest = await (await fetch(`${url}/manifest.webmanifest`)).json();
  assert.deepEqual({ action: manifest.share_target.action, method: manifest.share_target.method, enctype: manifest.share_target.enctype },
    { action: "/share", method: "POST", enctype: "multipart/form-data" });
  assert.deepEqual(manifest.shortcuts.map((shortcut) => shortcut.url),
    ["/#kin-action=add-shopping", "/#kin-action=quick-add", "/#kin-action=new-journal-entry", "/#week", "/#lists/shopping", "/#updates/chat", "/#today"]);
  // Android ignores SVG-only shortcut icons (#473): each has PNGs, served as PNG.
  for (const shortcut of manifest.shortcuts) {
    const icon = shortcut.icons.find((entry) => entry.sizes === "96x96");
    const response = await fetch(`${url}${icon.src}`);
    assert.equal(response.status, 200, icon.src);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).subarray(1, 4)], [0x50, 0x4e, 0x47]);
  }
});

test("a share POSTed to the server opens the app without keeping anything", async (t) => {
  const url = await start(t);
  const form = new FormData();
  form.set("text", "private note");
  form.append("files", new File(["secret"], "letter.pdf", { type: "application/pdf" }));
  const response = await fetch(`${url}/share`, { method: "POST", body: form, redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
});
