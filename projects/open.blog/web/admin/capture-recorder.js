// The Capture view's voice note (ADR 0298): the browser's MediaRecorder, feature-detected, permission-gated and
// bounded. It never starts without a tap, stops itself at the time or size limit, and keeps the recording in
// memory only until the author sends or discards the capture. Nothing here transcribes or uploads anything.
// Plain logic over injected browser objects, so tests drive it with a mocked recorder
// (tests/web/admin-capture-recorder.test.mjs).

export const RECORDER_TYPES = Object.freeze(["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]);
export const AUDIO_LIMITS = Object.freeze({ maxAudioSeconds: 180, maxAudioBytes: 8 * 1024 * 1024 });
const SLICE_MS = 1000;

/** The audio limits the server advertised, with the defaults for any it did not. */
export function audioLimits(meta = {}) {
  const limits = { ...AUDIO_LIMITS };
  for (const key of Object.keys(limits)) {
    const value = meta?.capture?.[key];
    if (Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return limits;
}

/** Whether this browser can record, and as which type: `{ supported, mimeType }`. A recorder with no type check records its default. */
export function recorderSupport({ mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder } = {}) {
  if (typeof Recorder !== "function" || typeof mediaDevices?.getUserMedia !== "function") return { supported: false, mimeType: "" };
  const known = typeof Recorder.isTypeSupported === "function" ? RECORDER_TYPES.find((type) => Recorder.isTypeSupported(type)) : "";
  if (typeof Recorder.isTypeSupported === "function" && !known) return { supported: false, mimeType: "" };
  return { supported: true, mimeType: known || "" };
}

/** `m:ss` for a number of seconds. */
export function clock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** What each way a start can fail should say. */
export const START_PROBLEMS = Object.freeze({
  gesture: "Recording starts only when you tap Record.",
  unsupported: "This browser cannot record audio. Type your notes instead.",
  denied: "The microphone is blocked for this site. Allow it in the browser's site settings, or type your notes instead.",
  unavailable: "No microphone could be opened. Type your notes instead.",
  busy: "A recording is already in progress.",
});

/**
 * `mediaDevices` and `Recorder` are the browser's (or a mock). `timers` is `{ setTimeout, clearTimeout,
 * setInterval, clearInterval, now }`. `onChange(state)` hears `idle`, `starting`, `recording` and `recorded`;
 * `onTick(seconds)` hears each second of a recording. Returns `{ state, support, start, stop, discard, result }`.
 */
export function createRecorder({
  mediaDevices = globalThis.navigator?.mediaDevices,
  Recorder = globalThis.MediaRecorder,
  limits = AUDIO_LIMITS,
  timers = { setTimeout: (run, ms) => globalThis.setTimeout(run, ms), clearTimeout: (id) => globalThis.clearTimeout(id), setInterval: (run, ms) => globalThis.setInterval(run, ms), clearInterval: (id) => globalThis.clearInterval(id), now: () => Date.now() },
  onChange = () => {},
  onTick = () => {},
} = {}) {
  const support = recorderSupport({ mediaDevices, Recorder });
  let state = "idle";
  let stream = null;
  let recorder = null;
  let chunks = [];
  let bytes = 0;
  let began = 0;
  let limitTimer = null;
  let tickTimer = null;
  let finished = null;
  let why = "";
  let outcome = null;
  let stopping = false;

  const set = (next) => {
    state = next;
    onChange(next);
  };

  const release = () => {
    timers.clearTimeout(limitTimer);
    timers.clearInterval(tickTimer);
    limitTimer = tickTimer = null;
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    stream = null;
  };

  const elapsed = () => Math.min(limits.maxAudioSeconds, Math.max(0, (timers.now() - began) / 1000));

  // The recorder's stop event (not our call to stop) is when the last chunk has arrived and the note is whole.
  const complete = () => {
    if (!recorder) return;
    const seconds = elapsed();
    const type = String(recorder?.mimeType || support.mimeType || chunks[0]?.type || "audio/webm").split(";")[0];
    const blob = new Blob(chunks, { type });
    recorder = null;
    stopping = false;
    release();
    if (!blob.size) {
      chunks = [];
      outcome = null;
      set("idle");
    } else {
      outcome = { blob, type, size: blob.size, seconds: Math.round(seconds * 10) / 10, reason: why || "stopped" };
      set("recorded");
    }
    finished?.(outcome);
    finished = null;
  };

  const halt = (reason) => {
    if (state !== "recording" || !recorder || stopping) return;
    stopping = true;
    why = reason;
    timers.clearTimeout(limitTimer);
    timers.clearInterval(tickTimer);
    try {
      recorder.stop();
    } catch {
      complete();
    }
  };

  return {
    support,
    get state() {
      return state;
    },
    result: () => outcome,
    /**
     * Begin recording. `event` must be the tap that asked for it (a trusted event); anything else, including a
     * script, is refused. Resolves `{ ok: true }` or `{ ok: false, reason }` and never throws.
     */
    async start(event) {
      if (event?.isTrusted !== true) return { ok: false, reason: "gesture" };
      if (!support.supported) return { ok: false, reason: "unsupported" };
      if (state !== "idle") return { ok: false, reason: "busy" };
      set("starting");
      try {
        stream = await mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        stream = null;
        set("idle");
        return { ok: false, reason: ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(error?.name) ? "denied" : "unavailable" };
      }
      if (state !== "starting") {
        // Discarded while the permission prompt was open.
        for (const track of stream.getTracks?.() ?? []) track.stop();
        stream = null;
        return { ok: false, reason: "busy" };
      }
      try {
        recorder = support.mimeType ? new Recorder(stream, { mimeType: support.mimeType }) : new Recorder(stream);
      } catch {
        release();
        set("idle");
        return { ok: false, reason: "unavailable" };
      }
      chunks = [];
      bytes = 0;
      why = "";
      outcome = null;
      recorder.ondataavailable = (data) => {
        const size = data?.data?.size ?? 0;
        if (!size || state !== "recording") return;
        if (bytes + size > limits.maxAudioBytes) {
          // Keep what fits: whole slices only, so the note still plays.
          halt("size");
          return;
        }
        chunks.push(data.data);
        bytes += size;
      };
      recorder.onstop = complete;
      recorder.onerror = () => halt("error");
      began = timers.now();
      set("recording");
      try {
        recorder.start(SLICE_MS);
      } catch {
        recorder = null;
        release();
        set("idle");
        return { ok: false, reason: "unavailable" };
      }
      onTick(0);
      limitTimer = timers.setTimeout(() => halt("time"), limits.maxAudioSeconds * 1000);
      tickTimer = timers.setInterval(() => onTick(Math.floor(elapsed())), 1000);
      return { ok: true };
    },
    /** Stop and keep the recording. Resolves the note `{ blob, type, size, seconds, reason }` or null. */
    stop() {
      if (state !== "recording") return Promise.resolve(outcome);
      return new Promise((resolve) => {
        finished = resolve;
        halt("stopped");
      });
    },
    /** Throw the recording away, in progress or finished, and let go of the microphone. */
    discard() {
      const live = recorder;
      recorder = null;
      if (live) {
        live.ondataavailable = null;
        live.onstop = null;
        live.onerror = null;
        try {
          if (live.state !== "inactive") live.stop();
        } catch {
          // Already stopped.
        }
      }
      release();
      chunks = [];
      bytes = 0;
      outcome = null;
      stopping = false;
      finished?.(null);
      finished = null;
      if (state !== "idle") set("idle");
    },
  };
}
