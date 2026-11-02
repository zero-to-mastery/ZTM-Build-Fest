import assert from "node:assert/strict";
import test from "node:test";

import { AUDIO_LIMITS, audioLimits, clock, createRecorder, recorderSupport } from "../../web/admin/capture-recorder.js";

const trusted = { isTrusted: true };

/** A MediaRecorder stand-in: chunks are fed by the test, and stop() delivers the last one then `stop`. */
function mockBrowser({ types = ["audio/webm;codecs=opus"], denied = "" } = {}) {
  const log = { streams: 0, trackStops: 0, recorders: [], permissionAsked: 0 };
  class MockRecorder {
    static isTypeSupported(type) { return types.includes(type); }
    constructor(stream, options = {}) {
      this.stream = stream;
      this.mimeType = options.mimeType || "";
      this.state = "inactive";
      this.pending = [];
      log.recorders.push(this);
    }
    start(slice) { this.state = "recording"; this.slice = slice; }
    emit(size, type = "audio/webm") { this.ondataavailable?.({ data: new Blob([new Uint8Array(size)], { type }) }); }
    stop() {
      if (this.state === "inactive") throw new Error("InvalidStateError");
      this.state = "inactive";
      this.emit(0);
      queueMicrotask(() => this.onstop?.());
    }
  }
  const mediaDevices = {
    async getUserMedia(constraints) {
      log.permissionAsked += 1;
      assert.deepEqual(constraints, { audio: true });
      if (denied) throw Object.assign(new Error(denied), { name: denied });
      log.streams += 1;
      return { getTracks: () => [{ stop: () => { log.trackStops += 1; } }] };
    },
  };
  return { mediaDevices, Recorder: MockRecorder, log };
}

function fakeTimers() {
  let now = 0;
  const timeouts = [];
  const intervals = [];
  return {
    now: () => now,
    setTimeout: (run, ms) => { const timer = { run, at: now + ms, live: true }; timeouts.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.live = false; },
    setInterval: (run, ms) => { const timer = { run, every: ms, live: true }; intervals.push(timer); return timer; },
    clearInterval: (timer) => { if (timer) timer.live = false; },
    advance(ms) {
      for (let spent = 0; spent < ms; spent += 1000) {
        now += Math.min(1000, ms - spent);
        for (const timer of intervals) if (timer.live) timer.run();
        for (const timer of timeouts) if (timer.live && timer.at <= now) { timer.live = false; timer.run(); }
      }
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("support is feature-detected: no recorder, no devices or no usable type means no Record control", () => {
  const { mediaDevices, Recorder } = mockBrowser();
  assert.deepEqual(recorderSupport({ mediaDevices, Recorder }), { supported: true, mimeType: "audio/webm;codecs=opus" });
  assert.equal(recorderSupport({ mediaDevices, Recorder: undefined }).supported, false);
  assert.equal(recorderSupport({ mediaDevices: undefined, Recorder }).supported, false);
  assert.equal(recorderSupport({ mediaDevices: {}, Recorder }).supported, false);
  assert.equal(recorderSupport({ mediaDevices: mockBrowser({ types: [] }).mediaDevices, Recorder: mockBrowser({ types: [] }).Recorder }).supported, false);
  assert.equal(recorderSupport({ mediaDevices, Recorder: mockBrowser({ types: ["audio/mp4"] }).Recorder }).mimeType, "audio/mp4");
});

test("the limits come from the server and fall back to three minutes and eight megabytes", () => {
  assert.deepEqual(audioLimits({}), AUDIO_LIMITS);
  assert.equal(AUDIO_LIMITS.maxAudioSeconds, 180);
  assert.equal(audioLimits({ capture: { maxAudioSeconds: 60, maxAudioBytes: "x" } }).maxAudioSeconds, 60);
  assert.equal(clock(0), "0:00");
  assert.equal(clock(65.9), "1:05");
  assert.equal(clock(180), "3:00");
});

test("recording never starts without a trusted tap and never asks for the microphone before one", async () => {
  const browser = mockBrowser();
  const recorder = createRecorder({ ...browser, timers: fakeTimers() });
  for (const event of [undefined, null, {}, { isTrusted: false }, new Event("click")]) {
    assert.deepEqual(await recorder.start(event), { ok: false, reason: "gesture" });
  }
  assert.equal(browser.log.permissionAsked, 0);
  assert.equal(recorder.state, "idle");
  assert.deepEqual(await recorder.start(trusted), { ok: true });
  assert.equal(browser.log.permissionAsked, 1);
  assert.equal(recorder.state, "recording");
  assert.deepEqual(await recorder.start(trusted), { ok: false, reason: "busy" });
  assert.equal(browser.log.permissionAsked, 1);
});

test("an unsupported browser and a refused microphone say so and leave nothing recording", async () => {
  const none = createRecorder({ mediaDevices: undefined, Recorder: undefined, timers: fakeTimers() });
  assert.deepEqual(await none.start(trusted), { ok: false, reason: "unsupported" });
  for (const [name, reason] of [["NotAllowedError", "denied"], ["SecurityError", "denied"], ["NotFoundError", "unavailable"]]) {
    const browser = mockBrowser({ denied: name });
    const states = [];
    const recorder = createRecorder({ ...browser, timers: fakeTimers(), onChange: (state) => states.push(state) });
    assert.deepEqual(await recorder.start(trusted), { ok: false, reason });
    assert.equal(recorder.state, "idle");
    assert.deepEqual(states, ["starting", "idle"]);
    assert.equal(browser.log.recorders.length, 0);
  }
});

test("stop keeps the note, releases the microphone and reports its length and size", async () => {
  const browser = mockBrowser();
  const timers = fakeTimers();
  const ticks = [];
  const recorder = createRecorder({ ...browser, timers, onTick: (seconds) => ticks.push(seconds) });
  await recorder.start(trusted);
  const live = browser.log.recorders[0];
  assert.equal(live.mimeType, "audio/webm;codecs=opus");
  live.emit(1000);
  timers.advance(3000);
  live.emit(2000);
  const note = await recorder.stop();
  assert.equal(recorder.state, "recorded");
  assert.deepEqual({ type: note.type, size: note.size, seconds: note.seconds, reason: note.reason }, { type: "audio/webm", size: 3000, seconds: 3, reason: "stopped" });
  assert.equal(browser.log.trackStops, 1, "the microphone is released");
  assert.deepEqual(ticks, [0, 1, 2, 3]);
  assert.equal(recorder.result(), note);
});

test("a recording stops itself at the time limit and keeps what was said", async () => {
  const browser = mockBrowser();
  const timers = fakeTimers();
  const states = [];
  const recorder = createRecorder({ ...browser, timers, limits: { maxAudioSeconds: 5, maxAudioBytes: 1e6 }, onChange: (state) => states.push(state) });
  await recorder.start(trusted);
  browser.log.recorders[0].emit(500);
  timers.advance(4000);
  assert.equal(recorder.state, "recording");
  timers.advance(1000);
  await settle();
  assert.equal(recorder.state, "recorded");
  assert.equal(recorder.result().reason, "time");
  assert.equal(recorder.result().seconds, 5);
  assert.equal(browser.log.trackStops, 1);
  assert.deepEqual(states, ["starting", "recording", "recorded"]);
});

test("a recording stops itself at the size limit and keeps only whole slices that fit", async () => {
  const browser = mockBrowser();
  const recorder = createRecorder({ ...browser, timers: fakeTimers(), limits: { maxAudioSeconds: 180, maxAudioBytes: 2500 } });
  await recorder.start(trusted);
  const live = browser.log.recorders[0];
  live.emit(1000);
  live.emit(1000);
  live.emit(1000);
  await settle();
  assert.equal(recorder.state, "recorded");
  assert.equal(recorder.result().reason, "size");
  assert.equal(recorder.result().size, 2000);
  assert.ok(recorder.result().size <= 2500);
  live.emit(10);
  assert.equal(recorder.result().size, 2000, "late data is ignored");
});

test("discard throws the recording away at any point and lets go of the microphone", async () => {
  const browser = mockBrowser();
  const timers = fakeTimers();
  const states = [];
  const recorder = createRecorder({ ...browser, timers, onChange: (state) => states.push(state) });
  await recorder.start(trusted);
  browser.log.recorders[0].emit(100);
  recorder.discard();
  assert.equal(recorder.state, "idle");
  assert.equal(recorder.result(), null);
  assert.equal(browser.log.trackStops, 1);
  await settle();
  assert.equal(recorder.state, "idle", "a late stop event changes nothing");
  timers.advance(200000);
  assert.deepEqual(states, ["starting", "recording", "idle"], "no timer fires after a discard");

  await recorder.start(trusted);
  browser.log.recorders[1].emit(100);
  await recorder.stop();
  assert.equal(recorder.state, "recorded");
  recorder.discard();
  assert.equal(recorder.state, "idle");
  assert.equal(recorder.result(), null);
  assert.equal(browser.log.trackStops, 2);
});

test("discarding while the permission prompt is open ends with no recorder and no open microphone", async () => {
  const browser = mockBrowser();
  const recorder = createRecorder({ ...browser, timers: fakeTimers() });
  const starting = recorder.start(trusted);
  recorder.discard();
  assert.deepEqual(await starting, { ok: false, reason: "busy" });
  assert.equal(recorder.state, "idle");
  assert.equal(browser.log.recorders.length, 0);
  assert.equal(browser.log.trackStops, 1);
});

test("a recorder that cannot be built or started fails cleanly", async () => {
  const browser = mockBrowser();
  const broken = createRecorder({ ...browser, Recorder: Object.assign(function Broken() { throw new Error("no"); }, { isTypeSupported: () => true }), timers: fakeTimers() });
  assert.deepEqual(await broken.start(trusted), { ok: false, reason: "unavailable" });
  assert.equal(broken.state, "idle");
  assert.equal(browser.log.trackStops, 1);
});
