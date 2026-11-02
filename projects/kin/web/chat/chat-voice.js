// Recording voice messages (#134): the browser's microphone and MediaRecorder,
// a clock that stops at five minutes, and the waveform. The browser pieces
// are injectable so this runs under Node tests; the real ones run in the
// browser regression.
//
// The microphone is asked for only when recording starts, and released the
// moment recording stops (or fails, or is discarded). Nothing is
// transcribed: a voice message is the recording and its waveform.
import { MAX_VOICE_MS, VOICE_PEAKS, VOICE_TYPES } from "./chat-attachments.js";

/** Recorder types in order of preference; the first the browser supports is used. */
export const VOICE_TYPE_CHOICES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
/** Most samples handed to the engine (wasm/kin-engine.js MAX_AUDIO_SAMPLES). */
const MAX_SAMPLES = 16_000_000;
const TICK_MS = 200;

export class VoiceError extends Error {
  constructor(message, code = "voice_failed") {
    super(message);
    this.name = "VoiceError";
    this.code = code;
  }
}

/** The recorder type to use, or null when the browser can record none we can send. */
export function chooseVoiceType(MediaRecorderCtor = globalThis.MediaRecorder) {
  if (typeof MediaRecorderCtor !== "function" || typeof MediaRecorderCtor.isTypeSupported !== "function") return null;
  return VOICE_TYPE_CHOICES.find((type) => {
    try { return MediaRecorderCtor.isTypeSupported(type); } catch { return false; }
  }) ?? null;
}

/** "audio/webm;codecs=opus" -> "audio/webm". */
export const baseType = (type) => String(type ?? "").split(";")[0].trim().toLowerCase();

/** Whether this browser can record a voice message, and if not, why. */
export function voiceSupport({ mediaDevices = globalThis.navigator?.mediaDevices, MediaRecorderCtor = globalThis.MediaRecorder } = {}) {
  if (typeof mediaDevices?.getUserMedia !== "function" || typeof MediaRecorderCtor !== "function")
    return { ok: false, reason: "This browser can't record audio." };
  if (!chooseVoiceType(MediaRecorderCtor)) return { ok: false, reason: "This browser can't record in a format Kin can send." };
  return { ok: true, reason: "" };
}

/** "0:42", "12:05": a length for a label or timer. */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What a screen reader says about a voice message. */
export function voiceLabel(author, ms) {
  return `Voice message from ${author}, ${formatDuration(ms)}`;
}

const explain = (error) => {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return new VoiceError("Kin can't use the microphone. Allow it for this site in your browser's settings, then try again.", "voice_denied");
    case "NotFoundError":
    case "OverconstrainedError":
      return new VoiceError("No microphone was found on this device.", "voice_no_microphone");
    case "NotReadableError":
    case "AbortError":
      return new VoiceError("The microphone is in use by another app. Close it and try again.", "voice_busy");
    default:
      return new VoiceError("Kin couldn't start recording. Try again.", "voice_failed");
  }
};

/**
 * One recording at a time. States: "idle", "starting", "recording",
 * "stopping". `start()` asks for the microphone (the first time the browser
 * asks the person), `stop()` resolves with `{ blob, durationMs, type }` and
 * `cancel()` throws the recording away. Both release the microphone at once.
 */
export class VoiceRecorder {
  constructor({
    mediaDevices = globalThis.navigator?.mediaDevices, MediaRecorderCtor = globalThis.MediaRecorder,
    now = () => Date.now(), setTimer = (work, ms) => setInterval(work, ms), clearTimer = (id) => clearInterval(id),
    maxMs = MAX_VOICE_MS, onTick = () => {}, onLimit = () => {}, onEnded = () => {},
  } = {}) {
    Object.assign(this, { mediaDevices, MediaRecorderCtor, now, setTimer, clearTimer, maxMs, onTick, onLimit, onEnded });
    this.state = "idle";
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.timer = null;
    this.startedAt = 0;
    this.pendingStop = null;
  }

  get elapsedMs() {
    return this.state === "recording" ? Math.min(this.now() - this.startedAt, this.maxMs) : 0;
  }

  async start() {
    if (this.state !== "idle") throw new VoiceError("A recording is already in progress.", "voice_busy");
    const type = chooseVoiceType(this.MediaRecorderCtor);
    if (!type || typeof this.mediaDevices?.getUserMedia !== "function")
      throw new VoiceError("This browser can't record audio in a format Kin can send.", "voice_unsupported");
    this.state = "starting";
    let stream;
    try {
      stream = await this.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      this.state = "idle";
      throw explain(error);
    }
    // Cancelled while the browser was asking.
    if (this.state !== "starting") {
      for (const track of stream.getTracks()) track.stop();
      throw new VoiceError("Recording was cancelled.", "voice_cancelled");
    }
    try {
      const recorder = new this.MediaRecorderCtor(stream, { mimeType: type });
      this.stream = stream;
      this.recorder = recorder;
      this.chunks = [];
      recorder.ondataavailable = (event) => { if (event.data?.size) this.chunks.push(event.data); };
      recorder.onerror = () => this.fail();
      recorder.onstop = () => this.finish(type);
      recorder.start(1000);
    } catch (error) {
      this.release();
      this.state = "idle";
      throw explain(error);
    }
    this.startedAt = this.now();
    this.state = "recording";
    this.timer = this.setTimer(() => this.tick(), TICK_MS);
    return type;
  }

  tick() {
    if (this.state !== "recording") return;
    const elapsed = this.now() - this.startedAt;
    this.onTick(Math.min(elapsed, this.maxMs));
    if (elapsed >= this.maxMs) {
      this.onLimit();
      void this.stop().catch(() => {});
    }
  }

  /** Ends the recording; resolves once the last data has arrived. */
  stop() {
    if (this.pendingStop) return this.pendingStop.promise;
    if (this.state !== "recording") return Promise.reject(new VoiceError("Nothing is being recorded.", "voice_idle"));
    this.state = "stopping";
    this.durationMs = Math.min(this.now() - this.startedAt, this.maxMs);
    this.clearTimer(this.timer);
    this.timer = null;
    const pending = {};
    pending.promise = new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }));
    this.pendingStop = pending;
    try { this.recorder.stop(); } catch { this.fail(); }
    return pending.promise;
  }

  finish(type) {
    const pending = this.pendingStop;
    const chunks = this.chunks;
    // The browser can end a recording by itself (a device unplugged, the
    // permission revoked): what was captured is handed to `onEnded`.
    const durationMs = pending ? this.durationMs : Math.min(this.now() - this.startedAt, this.maxMs);
    this.reset();
    const blob = new Blob(chunks, { type: baseType(type) });
    const empty = !blob.size || !VOICE_TYPES.has(blob.type) || durationMs < 1;
    if (!pending) {
      this.onEnded(empty ? null : { blob, durationMs, type: blob.type });
      return;
    }
    if (empty) pending.reject(new VoiceError("Nothing was recorded. Try again.", "voice_empty"));
    else pending.resolve({ blob, durationMs, type: blob.type });
  }

  fail() {
    const pending = this.pendingStop;
    this.reset();
    if (pending) pending.reject(new VoiceError("Recording stopped unexpectedly. Try again.", "voice_failed"));
    else this.onEnded(null);
  }

  /** Throws the recording away. */
  cancel() {
    const pending = this.pendingStop;
    if (this.recorder) {
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      try { if (this.recorder.state !== "inactive") this.recorder.stop(); } catch { /* already stopped */ }
    }
    this.reset();
    pending?.reject(new VoiceError("Recording was cancelled.", "voice_cancelled"));
  }

  release() {
    for (const track of this.stream?.getTracks?.() ?? []) track.stop();
    this.stream = null;
  }

  reset() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.release();
    this.recorder = null;
    this.chunks = [];
    this.pendingStop = null;
    this.state = "idle";
  }
}

/** The recording's samples as mono floats, and its length, through Web Audio. */
export async function decodeSamples(blob, AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext) {
  if (typeof AudioContextCtor !== "function") throw new VoiceError("This browser can't draw the waveform.", "voice_unsupported");
  const context = new AudioContextCtor();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    let length = buffer.length;
    // Long or high-rate recordings are kept within what the engine takes by
    // keeping each block's loudest sample, which is what a peak is.
    const step = Math.max(1, Math.ceil(length / MAX_SAMPLES));
    const samples = new Float32Array(Math.ceil(length / step));
    for (let index = 0; index < length; index += 1) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[index];
      mixed /= channels.length || 1;
      const slot = Math.floor(index / step);
      if (Math.abs(mixed) > Math.abs(samples[slot])) samples[slot] = mixed;
    }
    return { samples, durationMs: Math.round(buffer.duration * 1000) };
  } finally {
    context.close?.().catch?.(() => {});
  }
}

/**
 * The 64 waveform peaks for a recording, reduced by the engine. When the
 * browser can't decode it the waveform is a flat line: the message still
 * sends and plays.
 */
export async function voicePeaks(blob, engine, { AudioContextCtor } = {}) {
  try {
    const { samples } = await decodeSamples(blob, AudioContextCtor);
    if (samples.length) return Array.from(engine.audioPeaks(samples));
  } catch { /* a flat waveform below */ }
  return new Array(VOICE_PEAKS).fill(96);
}
