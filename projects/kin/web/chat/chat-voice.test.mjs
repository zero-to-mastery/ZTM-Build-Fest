// Voice recording (#134): the supported types, the microphone's life cycle,
// the five-minute limit and the waveform, with stand-ins for the browser.
import assert from "node:assert/strict";
import test from "node:test";
import { VoiceError, VoiceRecorder, baseType, chooseVoiceType, decodeSamples, formatDuration, voiceLabel, voicePeaks, voiceSupport } from "./chat-voice.js";

function fakeRecorderClass({ types = ["audio/webm;codecs=opus"], blobType = "audio/webm" } = {}) {
  const made = [];
  class FakeRecorder {
    static isTypeSupported(type) { return types.includes(type); }
    constructor(stream, options) { this.stream = stream; this.options = options; this.state = "inactive"; made.push(this); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(40)], { type: blobType }) });
        this.onstop?.();
      });
    }
  }
  FakeRecorder.made = made;
  return FakeRecorder;
}

function fakeMedia({ failWith = null } = {}) {
  const tracks = [];
  return {
    tracks, asked: 0,
    async getUserMedia(constraints) {
      this.asked += 1;
      this.constraints = constraints;
      if (failWith) throw Object.assign(new Error("no"), { name: failWith });
      const track = { stopped: false, stop() { this.stopped = true; } };
      tracks.push(track);
      return { getTracks: () => [track] };
    },
  };
}

function clock() {
  let time = 1_000;
  const timers = [];
  return {
    now: () => time, advance(ms) { time += ms; for (const timer of timers) timer(); },
    setTimer: (work) => { timers.push(work); return timers.length; }, clearTimer: (id) => { timers[id - 1] = () => {}; },
  };
}

test("a type is chosen only from what the browser can record, preferring opus in webm", () => {
  assert.equal(chooseVoiceType(fakeRecorderClass({ types: ["audio/webm;codecs=opus", "audio/mp4"] })), "audio/webm;codecs=opus");
  assert.equal(chooseVoiceType(fakeRecorderClass({ types: ["audio/mp4"] })), "audio/mp4");
  assert.equal(chooseVoiceType(fakeRecorderClass({ types: ["audio/x-flac"] })), null);
  assert.equal(chooseVoiceType(undefined), null);
  assert.equal(baseType("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(voiceSupport({ mediaDevices: fakeMedia(), MediaRecorderCtor: fakeRecorderClass() }).ok, true);
  assert.match(voiceSupport({ mediaDevices: undefined, MediaRecorderCtor: fakeRecorderClass() }).reason, /can't record audio/);
  assert.match(voiceSupport({ mediaDevices: fakeMedia(), MediaRecorderCtor: fakeRecorderClass({ types: [] }) }).reason, /format/);
});

test("lengths and labels read like speech", () => {
  assert.equal(formatDuration(42_000), "0:42");
  assert.equal(formatDuration(725_900), "12:05");
  assert.equal(formatDuration(-5), "0:00");
  assert.equal(voiceLabel("Sam", 42_000), "Voice message from Sam, 0:42");
});

test("recording asks for the microphone once, then releases it the moment it stops", async () => {
  const media = fakeMedia();
  const time = clock();
  const ticks = [];
  const recorder = new VoiceRecorder({ mediaDevices: media, MediaRecorderCtor: fakeRecorderClass(), ...time, onTick: (ms) => ticks.push(ms) });
  assert.equal(media.asked, 0, "nothing is asked before the first tap");
  assert.equal(await recorder.start(), "audio/webm;codecs=opus");
  assert.deepEqual(media.constraints, { audio: true });
  assert.equal(recorder.state, "recording");
  await assert.rejects(recorder.start(), (error) => error.code === "voice_busy");
  time.advance(2_500);
  assert.deepEqual(ticks, [2_500]);
  assert.equal(recorder.elapsedMs, 2_500);
  const result = await recorder.stop();
  assert.equal(result.durationMs, 2_500);
  assert.equal(result.type, "audio/webm");
  assert.equal(result.blob.size, 40);
  assert.ok(media.tracks[0].stopped, "the microphone is released");
  assert.equal(recorder.state, "idle");
  await assert.rejects(recorder.stop(), (error) => error.code === "voice_idle");
});

test("it stops itself at five minutes and says so", async () => {
  const time = clock();
  let limited = 0;
  const recorder = new VoiceRecorder({ mediaDevices: fakeMedia(), MediaRecorderCtor: fakeRecorderClass(), ...time, onLimit: () => { limited += 1; } });
  await recorder.start();
  time.advance(299_000);
  assert.equal(recorder.state, "recording");
  time.advance(2_000);
  assert.equal(limited, 1);
  assert.equal(recorder.state, "stopping");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recorder.state, "idle");
});

test("a recording can be thrown away, even while the browser is still asking", async () => {
  const media = fakeMedia();
  const recorder = new VoiceRecorder({ mediaDevices: media, MediaRecorderCtor: fakeRecorderClass(), ...clock() });
  await recorder.start();
  const stopping = recorder.stop();
  recorder.cancel();
  await assert.rejects(stopping, (error) => error.code === "voice_cancelled");
  assert.ok(media.tracks[0].stopped);
  assert.equal(recorder.state, "idle");

  let release;
  const slow = { async getUserMedia() { await new Promise((resolve) => { release = resolve; }); const track = { stopped: false, stop() { this.stopped = true; } }; slow.track = track; return { getTracks: () => [track] }; } };
  const early = new VoiceRecorder({ mediaDevices: slow, MediaRecorderCtor: fakeRecorderClass(), ...clock() });
  const starting = early.start();
  early.cancel();
  release();
  await assert.rejects(starting, (error) => error.code === "voice_cancelled");
  assert.ok(slow.track.stopped, "a microphone granted late is released at once");
});

test("a denied, missing or busy microphone and an unsupported browser each get their own plain message", async () => {
  const cases = { NotAllowedError: "voice_denied", NotFoundError: "voice_no_microphone", NotReadableError: "voice_busy", WeirdError: "voice_failed" };
  for (const [name, code] of Object.entries(cases)) {
    const recorder = new VoiceRecorder({ mediaDevices: fakeMedia({ failWith: name }), MediaRecorderCtor: fakeRecorderClass(), ...clock() });
    await assert.rejects(recorder.start(), (error) => error instanceof VoiceError && error.code === code, name);
    assert.equal(recorder.state, "idle", "can try again");
  }
  const unsupported = new VoiceRecorder({ mediaDevices: fakeMedia(), MediaRecorderCtor: fakeRecorderClass({ types: [] }), ...clock() });
  await assert.rejects(unsupported.start(), (error) => error.code === "voice_unsupported");
});

test("an empty recording is refused instead of sent", async () => {
  const empty = fakeRecorderClass();
  empty.prototype.stop = function stop() { this.state = "inactive"; queueMicrotask(() => this.onstop?.()); };
  const recorder = new VoiceRecorder({ mediaDevices: fakeMedia(), MediaRecorderCtor: empty, ...clock() });
  await recorder.start();
  await assert.rejects(recorder.stop(), (error) => error.code === "voice_empty");
});

test("the waveform comes from the engine, mixed to mono and kept within its limit", async () => {
  const left = Float32Array.from([0.5, -0.25, 0, 0]);
  const right = Float32Array.from([0.5, 0.25, 0, 1]);
  class Context {
    async decodeAudioData() { return { numberOfChannels: 2, length: 4, duration: 0.5, getChannelData: (index) => [left, right][index] }; }
    close() { return Promise.resolve(); }
  }
  const { samples, durationMs } = await decodeSamples(new Blob([new Uint8Array(3)]), Context);
  assert.deepEqual(Array.from(samples), [0.5, 0, 0, 0.5]);
  assert.equal(durationMs, 500);
  const calls = [];
  const engine = { audioPeaks: (input) => { calls.push(input); return Uint8Array.from({ length: 64 }, (_, index) => index); } };
  const peaks = await voicePeaks(new Blob([new Uint8Array(3)]), engine, { AudioContextCtor: Context });
  assert.equal(calls.length, 1);
  assert.equal(peaks.length, 64);
  assert.equal(peaks[63], 63);
  // A browser that can't decode it still sends: a flat waveform.
  class Broken { async decodeAudioData() { throw new Error("EncodingError"); } }
  const flat = await voicePeaks(new Blob([new Uint8Array(3)]), engine, { AudioContextCtor: Broken });
  assert.deepEqual(flat, new Array(64).fill(96));
  assert.equal(calls.length, 1);
});

test("a recording the browser ends by itself is handed over, not lost", async () => {
  const time = clock();
  const ended = [];
  const Recorder = fakeRecorderClass();
  const recorder = new VoiceRecorder({ mediaDevices: fakeMedia(), MediaRecorderCtor: Recorder, ...time, onEnded: (result) => ended.push(result) });
  await recorder.start();
  time.advance(3_000);
  const native = Recorder.made[0];
  native.ondataavailable({ data: new Blob([new Uint8Array(10)], { type: "audio/webm" }) });
  native.onstop();
  assert.equal(ended.length, 1);
  assert.equal(ended[0].durationMs, 3_000);
  assert.equal(recorder.state, "idle");

  const none = [];
  const second = new VoiceRecorder({ mediaDevices: fakeMedia(), MediaRecorderCtor: Recorder, ...time, onEnded: (result) => none.push(result) });
  await second.start();
  Recorder.made[1].onerror();
  assert.deepEqual(none, [null]);
});
