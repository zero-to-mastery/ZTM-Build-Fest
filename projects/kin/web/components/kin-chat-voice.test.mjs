// The voice player and recorder panel (#134) against a tiny DOM.
import assert from "node:assert/strict";
import test from "node:test";

class Node_ {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.classes = new Set(); this.style = {}; this.hidden = false; this.textContent = ""; this.value = ""; }
  get className() { return [...this.classes].join(" "); }
  set className(value) { this.classes = new Set(value.split(" ").filter(Boolean)); }
  get classList() { return { toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)), add: (name) => this.classes.add(name) }; }
  setAttribute(name, value) { this.attrs[name] = value; }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  async fire(type) { for (const fn of this.listeners[type] ?? []) await fn({}); }
  focus() { Node_.focused = this; }
  find(predicate) { if (predicate(this)) return this; for (const child of this.children) { const found = child.find?.(predicate); if (found) return found; } return null; }
}
globalThis.document = { createElement: (tag) => new Node_(tag) };
const { VoiceComposer, voicePlayer } = await import("./kin-chat-voice.js");

const byClass = (root, name) => root.find((node) => node.classes?.has(name));
const peaks = Array.from({ length: 64 }, (_, index) => index * 4);

function fakeAudio() {
  const made = [];
  class FakeAudio {
    constructor(url) { this.url = url; this.paused = true; this.currentTime = 0; this.handlers = {}; made.push(this); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    async play() { this.paused = false; this.handlers.play?.(); }
    pause() { this.paused = true; this.handlers.pause?.(); }
  }
  FakeAudio.made = made;
  return FakeAudio;
}

test("the player names itself, loads on first play, and seeks and changes speed", async () => {
  const Audio = fakeAudio();
  let loads = 0;
  const revoked = [];
  const player = voicePlayer({ author: "Sam", voice: { durationMs: 42_000, peaks }, load: async () => { loads += 1; return new Blob([new Uint8Array(4)]); }, Audio, createUrl: () => "blob:x", revokeUrl: (url) => revoked.push(url) });
  assert.equal(player.attrs["aria-label"], "Voice message from Sam, 0:42");
  const play = byClass(player, "chat-voice-play");
  assert.equal(play.attrs["aria-label"], "Play voice message from Sam");
  assert.equal(loads, 0, "nothing is decrypted until it is played");
  await play.fire("click");
  assert.equal(loads, 1);
  assert.equal(play.textContent, "Pause");
  const audio = Audio.made[0];
  await play.fire("click");
  assert.equal(play.textContent, "Play");
  assert.equal(audio.paused, true);
  await play.fire("click");
  assert.equal(loads, 1, "loaded once");

  const seek = byClass(player, "chat-voice-seek");
  seek.value = "21000";
  await seek.fire("input");
  assert.equal(audio.currentTime, 21);
  assert.equal(seek.attrs["aria-valuetext"], "0:21 of 0:42");
  const speed = byClass(player, "chat-voice-speed");
  await speed.fire("click");
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(speed.attrs["aria-label"], "Playback speed 1.5×");
  await speed.fire("click");
  await speed.fire("click");
  assert.equal(audio.playbackRate, 1);
  player.dispose();
  assert.deepEqual(revoked, ["blob:x"]);
});

test("a recording that can't be opened says so", async () => {
  const player = voicePlayer({ author: "Sam", voice: { durationMs: 1000, peaks }, load: async () => { throw new Error("gone"); }, Audio: fakeAudio() });
  await byClass(player, "chat-voice-play").fire("click");
  assert.match(byClass(player, "chat-voice-problem").textContent, /Couldn't play/);
});

function stubRecorder(result) {
  return {
    state: "recording", cancelled: false,
    async start() {}, stop() { this.state = "idle"; return Promise.resolve(result); },
    cancel() { this.cancelled = true; this.state = "idle"; },
  };
}

test("the panel goes from recording to review, sends once, and discards cleanly", async () => {
  const host = new Node_("div");
  const sent = [];
  const said = [];
  const urls = [];
  const composer = new VoiceComposer({
    host, say: (text) => said.push(text), send: async (recording) => { sent.push(recording); },
    support: () => ({ ok: true, reason: "" }), createUrl: () => { urls.push("u"); return "blob:r"; }, revokeUrl: (url) => urls.push(`revoked ${url}`),
  });
  assert.equal(host.hidden, true);
  const result = { blob: new Blob([new Uint8Array(5)], { type: "audio/webm" }), durationMs: 3000, type: "audio/webm" };
  composer.begin = async function begin() { this.recorder = stubRecorder(result); this.show("recording"); };
  await composer.begin();
  assert.equal(host.hidden, false);
  assert.ok(byClass(host, "chat-voice-stop"));
  await byClass(host, "chat-voice-stop").fire("click");
  assert.equal(composer.state, "review");
  assert.ok(byClass(host, "chat-voice-send"));
  assert.match(said.at(-1), /Recorded 0:03/);
  await byClass(host, "chat-voice-send").fire("click");
  assert.deepEqual(sent, [result]);
  assert.equal(host.hidden, true);
  assert.ok(urls.includes("revoked blob:r"), "the preview URL is released");

  // Discarding while recording cancels and releases.
  await composer.begin();
  const recorder = composer.recorder;
  await byClass(host, "chat-voice-discard").fire("click");
  assert.ok(recorder.cancelled);
  assert.equal(host.hidden, true);
});

test("a failed send keeps the recording; an unsupported browser says why", async () => {
  const host = new Node_("div");
  let fail = true;
  const composer = new VoiceComposer({
    host, send: async () => { if (fail) throw new Error("offline"); }, support: () => ({ ok: true, reason: "" }), createUrl: () => "blob:r", revokeUrl() {},
  });
  composer.result = { blob: new Blob([new Uint8Array(5)]), durationMs: 2000, type: "audio/webm" };
  composer.url = "blob:r";
  composer.show("review");
  await composer.send();
  assert.equal(composer.state, "review");
  assert.match(host.children[0].textContent, /still here/);
  fail = false;
  await composer.send();
  assert.equal(host.hidden, true);

  const unsupported = new VoiceComposer({ host: new Node_("div"), send: async () => {}, support: () => ({ ok: false, reason: "This browser can't record audio." }) });
  await unsupported.begin();
  assert.equal(unsupported.host.children[0].attrs.role, "alert");
  assert.equal(unsupported.host.children[0].textContent, "This browser can't record audio.");
});

test("hiding the page stops a recording and keeps it for review", async () => {
  const host = new Node_("div");
  const composer = new VoiceComposer({ host, send: async () => {}, createUrl: () => "blob:r", revokeUrl() {} });
  const result = { blob: new Blob([new Uint8Array(5)]), durationMs: 5000, type: "audio/webm" };
  composer.recorder = stubRecorder(result);
  composer.show("recording");
  composer.interrupt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(composer.state, "review");
  assert.equal(composer.result, result);
});

test("only one voice message plays at a time, and disposing while loading leaves nothing behind", async () => {
  const Audio = fakeAudio();
  const make = (load) => voicePlayer({ author: "Sam", voice: { durationMs: 5000, peaks }, load, Audio, createUrl: () => "blob:x", revokeUrl: () => {} });
  const one = make(async () => new Blob([new Uint8Array(2)]));
  const two = make(async () => new Blob([new Uint8Array(2)]));
  await byClass(one, "chat-voice-play").fire("click");
  await byClass(two, "chat-voice-play").fire("click");
  assert.equal(Audio.made[0].paused, true, "the first was paused");
  assert.equal(Audio.made[1].paused, false);

  let release;
  const revoked = [];
  const slow = voicePlayer({ author: "Sam", voice: { durationMs: 5000, peaks }, load: () => new Promise((resolve) => { release = () => resolve(new Blob([new Uint8Array(2)])); }), Audio, createUrl: () => "blob:late", revokeUrl: (url) => revoked.push(url) });
  const pressed = byClass(slow, "chat-voice-play").fire("click");
  slow.dispose();
  release();
  await pressed;
  assert.equal(Audio.made.length, 2, "no player is made after disposal");
  assert.match(byClass(slow, "chat-voice-problem").textContent, /Couldn't play/);
});

test("the Cancel button leaves the starting state; a recording the browser ends is kept for review", async () => {
  const host = new Node_("div");
  const composer = new VoiceComposer({ host, send: async () => {}, createUrl: () => "blob:r", revokeUrl() {} });
  composer.recorder = { state: "starting", cancel() { this.cancelled = true; } };
  composer.show("starting");
  assert.ok(Node_.focused === byClass(host, "chat-voice-discard"), "focus moves into the panel");
  await byClass(host, "chat-voice-discard").fire("click");
  assert.equal(host.hidden, true);

  composer.ended({ blob: new Blob([new Uint8Array(3)]), durationMs: 2000, type: "audio/webm" });
  assert.equal(composer.state, "review");
  assert.match(host.children[0].textContent, /stopped on its own/);
  composer.ended(null);
  assert.equal(composer.state, "problem");

  // Closing while a send is in flight leaves the panel closed, not broken.
  const closing = new VoiceComposer({ host: new Node_("div"), send: async () => { closing.dispose(); throw new Error("locked"); }, createUrl: () => "blob:r", revokeUrl() {} });
  closing.result = { blob: new Blob([new Uint8Array(3)]), durationMs: 2000, type: "audio/webm" };
  closing.url = "blob:r";
  closing.show("review");
  await closing.send();
  assert.equal(closing.host.hidden, true);
});
