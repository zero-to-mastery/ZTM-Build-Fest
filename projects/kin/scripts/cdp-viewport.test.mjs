// Issue #164: viewport changes are only trusted once the page reports them.
import assert from "node:assert/strict";
import test from "node:test";
import { setViewport } from "./cdp-viewport.mjs";

const fakeClient = (sizes) => {
  const sent = [];
  let index = 0;
  return {
    sent,
    async send(method, params) { sent.push([method, params]); },
    async evaluate() {
      const next = sizes[Math.min(index++, sizes.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
};

test("setViewport waits until the page reports the requested size", async () => {
  const client = fakeClient([{ width: 394, height: 780 }, { width: 394, height: 780 }, { width: 320, height: 780 }]);
  const reported = await setViewport(client, { width: 320, height: 780, deviceScaleFactor: 1, mobile: true });
  assert.deepEqual(reported, { width: 320, height: 780 });
  assert.deepEqual(client.sent, [["Emulation.setDeviceMetricsOverride", { width: 320, height: 780, deviceScaleFactor: 1, mobile: true }]]);
});

test("setViewport keeps waiting through a lost page context", async () => {
  const client = fakeClient([new Error('{"code":-32000,"message":"Execution context was destroyed."}'), { width: 1280, height: 720 }]);
  assert.deepEqual(await setViewport(client, { width: 1280, height: 720 }), { width: 1280, height: 720 });
});

test("setViewport fails clearly when the size never arrives, and rethrows other errors", async () => {
  await assert.rejects(setViewport(fakeClient([{ width: 394, height: 780 }]), { width: 320, height: 780 }, { timeoutMs: 120 }),
    /did not reach 320x780 within 120 ms; the page reports 394x780/);
  await assert.rejects(setViewport(fakeClient([new Error("boom")]), { width: 320, height: 780 }), /boom/);
  await assert.rejects(setViewport(fakeClient([]), { width: "320", height: 780 }), TypeError);
});
