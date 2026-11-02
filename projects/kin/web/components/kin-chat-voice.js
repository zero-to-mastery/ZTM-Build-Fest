// Voice messages in the chat (#134): the player shown in a message and the
// recorder panel in the composer. Both are plain DOM built with textContent;
// no transcription, no uploads outside the chat's own sealed attachment path.
import { VoiceError, VoiceRecorder, formatDuration, voiceLabel, voicePeaks, voiceSupport } from "../chat/chat-voice.js";

const SPEEDS = [1, 1.5, 2];

const button = (className, text, label) => {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  if (label) element.setAttribute("aria-label", label);
  return element;
};

/**
 * One voice message: play/pause, a waveform you can drag along, the time and
 * a speed button. `load()` resolves the decrypted recording the first time
 * it is played; its object URL is released by `dispose()`.
 */
let playingNow = null;

export function voicePlayer({ author, voice, load, Audio = globalThis.Audio, createUrl = (blob) => URL.createObjectURL(blob), revokeUrl = (url) => URL.revokeObjectURL(url) }) {
  const root = document.createElement("div");
  root.className = "chat-voice";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", voiceLabel(author, voice.durationMs));
  const play = button("chat-voice-play", "Play", `Play voice message from ${author}`);
  const wave = document.createElement("div");
  wave.className = "chat-voice-wave";
  wave.setAttribute("aria-hidden", "true");
  const bars = voice.peaks.map((peak) => {
    const bar = document.createElement("span");
    bar.style.height = `${Math.max(8, Math.round((peak / 255) * 100))}%`;
    wave.append(bar);
    return bar;
  });
  const seek = document.createElement("input");
  seek.type = "range";
  seek.className = "chat-voice-seek";
  seek.min = "0";
  seek.max = String(voice.durationMs);
  seek.step = "100";
  seek.value = "0";
  seek.setAttribute("aria-label", `Position in voice message from ${author}`);
  seek.setAttribute("aria-valuetext", `0:00 of ${formatDuration(voice.durationMs)}`);
  const time = document.createElement("span");
  time.className = "chat-voice-time";
  time.textContent = formatDuration(voice.durationMs);
  const speed = button("chat-voice-speed", "1×", "Playback speed 1×");
  const problem = document.createElement("span");
  problem.className = "chat-voice-problem";
  problem.setAttribute("role", "status");
  const track = document.createElement("div");
  track.className = "chat-voice-track";
  track.append(wave, seek);
  root.append(play, track, time, speed, problem);

  let audio = null;
  let url = null;
  let rate = 1;
  let loading = null;
  let disposed = false;

  const paint = (ms) => {
    const played = Math.round((ms / voice.durationMs) * bars.length);
    bars.forEach((bar, index) => bar.classList.toggle("played", index < played));
    seek.value = String(Math.round(ms));
    seek.setAttribute("aria-valuetext", `${formatDuration(ms)} of ${formatDuration(voice.durationMs)}`);
    time.textContent = formatDuration(audio && !audio.paused ? ms : ms || voice.durationMs);
  };
  const setPlaying = (playing) => {
    play.textContent = playing ? "Pause" : "Play";
    play.setAttribute("aria-label", `${playing ? "Pause" : "Play"} voice message from ${author}`);
  };
  const ensure = () => {
    if (audio) return Promise.resolve(audio);
    loading ??= (async () => {
      const blob = await load();
      if (disposed) throw new Error("disposed");
      url = createUrl(blob);
      const element = new Audio(url);
      audio = element;
      element.preload = "auto";
      element.playbackRate = rate;
      // Browser-made webm has no length until it has been read to the end,
      // which makes seeking fail: reading to the end once and coming back
      // gives it one.
      element.addEventListener("loadedmetadata", () => {
        if (element.duration !== Infinity) return;
        const back = () => { element.removeEventListener("timeupdate", back); element.currentTime = 0; };
        element.addEventListener("timeupdate", back);
        element.currentTime = 1e101;
      });
      element.addEventListener("timeupdate", () => paint(Math.min(element.currentTime * 1000, voice.durationMs)));
      element.addEventListener("ended", () => { setPlaying(false); paint(0); });
      element.addEventListener("pause", () => setPlaying(false));
      element.addEventListener("play", () => {
        setPlaying(true);
        // One voice message at a time.
        if (playingNow && playingNow !== root) playingNow.pauseVoice();
        playingNow = root;
      });
      return element;
    })().finally(() => { loading = null; });
    return loading;
  };

  play.addEventListener("click", async () => {
    problem.textContent = "";
    try {
      const element = await ensure();
      if (element.paused) await element.play();
      else element.pause();
    } catch {
      problem.textContent = "Couldn't play this voice message.";
    }
  });
  seek.addEventListener("input", async () => {
    const ms = Number(seek.value);
    paint(ms);
    try { (await ensure()).currentTime = ms / 1000; } catch { problem.textContent = "Couldn't play this voice message."; }
  });
  speed.addEventListener("click", () => {
    rate = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length];
    speed.textContent = `${rate}×`;
    speed.setAttribute("aria-label", `Playback speed ${rate}×`);
    if (audio) audio.playbackRate = rate;
    problem.textContent = `Speed ${rate}×`;
  });
  root.pauseVoice = () => audio?.pause();

  root.dispose = () => {
    disposed = true;
    if (playingNow === root) playingNow = null;
    audio?.pause();
    audio = null;
    if (url) revokeUrl(url);
    url = null;
  };
  return root;
}

/**
 * The recorder in the composer. `host` is the element it fills; `send`
 * receives `{ blob, durationMs }` and sends it (the caller adds peaks).
 * States: closed → starting → recording → review → closed. The microphone is
 * released when recording stops, and a recording stopped by the page
 * hiding or locking is kept for review, not sent.
 */
export class VoiceComposer {
  constructor({ host, say = () => {}, send, support = voiceSupport, shown = () => host.getClientRects?.().length !== 0, recorderOptions = {}, createUrl = (blob) => URL.createObjectURL(blob), revokeUrl = (url) => URL.revokeObjectURL(url), onChange = () => {} }) {
    Object.assign(this, { host, say, sendRecording: send, support, shown, createUrl, revokeUrl, onChange });
    this.interruptedStart = false;
    this.recorderOptions = recorderOptions;
    this.recorder = null;
    this.result = null;
    this.url = null;
    this.busy = false;
    host.hidden = true;
  }

  get open() { return !this.host.hidden; }

  /** Starts a recording (asks for the microphone when this is the first). */
  async begin() {
    if (this.open) return;
    this.interruptedStart = false;
    const support = this.support();
    if (!support.ok) { this.show("problem", support.reason); return; }
    this.show("starting");
    this.recorder = new VoiceRecorder({
      ...this.recorderOptions,
      onTick: (ms) => {
        if (this.clock) this.clock.textContent = formatDuration(ms);
        // The chat went out of view (another page of the app): stop here.
        if (!this.shown()) this.interrupt();
      },
      onEnded: (result) => this.ended(result),
      // At the limit the recording ends on its own and goes to review.
      onLimit: () => { this.say("Five minutes reached. Recording stopped."); void this.stop(); },
    });
    try {
      await this.recorder.start();
    } catch (error) {
      if (error?.code === "voice_cancelled") return;
      this.recorder = null;
      this.show("problem", error instanceof VoiceError ? error.message : "Kin couldn't start recording.");
      return;
    }
    this.show("recording");
    this.say("Recording");
    // The page was hidden while the browser was asking: keep what little there is.
    if (this.interruptedStart) { this.interruptedStart = false; await this.stop(); }
  }

  async stop() {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== "recording" && recorder.state !== "stopping") return;
    try {
      this.result = await recorder.stop();
    } catch (error) {
      if (error?.code === "voice_cancelled") return;
      this.recorder = null;
      this.show("problem", error instanceof VoiceError ? error.message : "Recording failed.");
      return;
    }
    this.recorder = null;
    this.url = this.createUrl(this.result.blob);
    this.show("review");
    this.say(`Recorded ${formatDuration(this.result.durationMs)}. Review it, then send or discard.`);
  }

  /** The page hid or the chat locked: stop and keep what was said. */
  interrupt() {
    if (this.recorder?.state === "recording") void this.stop();
    else if (this.state === "starting") this.interruptedStart = true;
  }

  /** The browser ended the recording on its own. */
  ended(result) {
    this.recorder = null;
    if (!result) { this.show("problem", "The recording stopped and nothing was kept. Try again."); return; }
    this.result = result;
    this.url = this.createUrl(result.blob);
    this.show("review", "The recording stopped on its own. Review what was kept.");
    this.say("The recording stopped on its own.");
  }

  discard() {
    this.interruptedStart = false;
    this.recorder?.cancel();
    this.recorder = null;
    this.clear();
    this.show(null);
    this.onChange();
  }

  /** Closes everything, e.g. when the element leaves the page. */
  dispose() {
    this.interruptedStart = false;
    this.recorder?.cancel();
    this.recorder = null;
    this.clear();
    this.host.replaceChildren();
    this.host.hidden = true;
  }

  clear() {
    this.result = null;
    if (this.url) this.revokeUrl(this.url);
    this.url = null;
  }

  async send() {
    if (!this.result || this.busy) return;
    this.busy = true;
    this.show("sending");
    try {
      await this.sendRecording(this.result);
      this.clear();
      this.show(null);
    } catch (error) {
      this.busy = false;
      // Closed (locked, or access changed) while sending: nothing to show.
      if (!this.result) return;
      this.show("review", error?.message && error.code === "chat_attachment_invalid" ? error.message : "Kin couldn't send that. Your recording is still here.");
      return;
    }
    this.busy = false;
    this.onChange();
  }

  show(state, text = "") {
    if (state === "review" && !this.result) state = null;
    this.state = state;
    const host = this.host;
    host.replaceChildren();
    host.hidden = state === null;
    if (state === null) { this.clock = null; this.onChange(); return; }
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", "Voice message");
    const status = document.createElement("p");
    status.className = "chat-voice-status";
    if (state === "starting") status.textContent = "Starting the microphone…";
    else if (state === "sending") status.textContent = "Sending voice message…";
    else if (state === "problem") status.textContent = text;
    else if (state === "recording") status.textContent = "Recording ";
    else if (state === "review") status.textContent = text || "Voice message ready";
    if (state === "problem") status.setAttribute("role", "alert");
    host.append(status);
    this.clock = null;
    host.tabIndex = -1;
    if (state === "starting") {
      const cancel = button("chat-voice-discard", "Cancel", "Cancel recording");
      cancel.addEventListener("click", () => this.discard());
      host.append(cancel);
      cancel.focus();
    } else if (state === "sending") {
      host.focus?.();
    } else if (state === "recording") {
      this.clock = document.createElement("span");
      this.clock.className = "chat-voice-clock";
      this.clock.textContent = "0:00";
      status.append(this.clock);
      const stop = button("chat-voice-stop", "Stop", "Stop recording");
      stop.addEventListener("click", () => void this.stop());
      const discard = button("chat-voice-discard", "Discard", "Discard recording");
      discard.addEventListener("click", () => this.discard());
      host.append(stop, discard);
      stop.focus();
    } else if (state === "review") {
      const player = document.createElement("audio");
      player.controls = true;
      player.src = this.url;
      player.setAttribute("aria-label", `Your recording, ${formatDuration(this.result.durationMs)}`);
      const send = button("chat-voice-send", "Send voice message", "Send voice message");
      send.addEventListener("click", () => void this.send());
      const discard = button("chat-voice-discard", "Discard", "Discard recording");
      discard.addEventListener("click", () => this.discard());
      host.append(player, send, discard);
      send.focus();
    } else if (state === "problem") {
      const close = button("chat-voice-discard", "Close", "Close voice message");
      close.addEventListener("click", () => this.discard());
      host.append(close);
      close.focus();
    }
    this.onChange();
  }
}

export { voicePeaks };
