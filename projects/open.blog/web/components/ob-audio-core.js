// The Web Audio signal lab without a page: one oscillator, a low-pass filter, an analyser and a
// quiet fixed gain. Shared by <ob-audio-lab> and the Web Audio series landing page, which only
// differ in the markup they bind to the `ui` callbacks. Sound starts only from a call to
// `start()` (a reader gesture), and ends on stop, when the tab is hidden, or on pagehide.

export const FLAT_TRACE = "M0 75H480";
export const OUTPUT_GAIN = 0.025;
export const WAVEFORMS = [
  ["sine", "Sine / smooth"],
  ["triangle", "Triangle / mellow"],
  ["sawtooth", "Sawtooth / bright"],
  ["square", "Square / hollow"],
];

// Time-domain analyser bytes (128 is silence) to an SVG path 480 wide, centred on y = 75.
export function tracePath(samples) {
  return Array.from({ length: 240 }, (_, i) => {
    const sample = samples[i * 2];
    return `${i ? "L" : "M"}${(i * 480 / 239).toFixed(1)} ${(75 + (sample - 128) * 0.5).toFixed(1)}`;
  }).join("");
}

// ui: { settings(): { shape, frequency, cutoff }, status(text), badge(text),
//       trace(path), controls({ canStart, canStop }) }
export function createSignalLab(ui) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let session;
  let busy = false;
  let frame;
  let version = 0;

  function report(error) {
    console.error("Web Audio signal lab:", error);
    ui.status(`Sound lab error: ${error.message}. Playback stopped; try Start again.`);
    ui.badge("ERROR");
  }

  function stopTrace() {
    cancelAnimationFrame(frame);
    frame = undefined;
    ui.trace(FLAT_TRACE);
  }

  function draw() {
    if (!session || motion.matches) return;
    session.analyser.getByteTimeDomainData(session.samples);
    ui.trace(tracePath(session.samples));
    frame = requestAnimationFrame(draw);
  }

  function controls() {
    ui.controls({ canStart: !busy && !session, canStop: !!session || busy });
  }

  async function end(message = "Stopped. Press Start to listen again.") {
    version++;
    const previous = session;
    session = undefined;
    stopTrace();
    if (!previous) {
      ui.badge("STOPPED");
      ui.status(message);
      return;
    }
    busy = true;
    controls();
    previous.context.onstatechange = null;
    try {
      previous.oscillator.stop();
      previous.oscillator.disconnect();
      previous.filter.disconnect();
      previous.analyser.disconnect();
      previous.gain.disconnect();
      if (previous.context.state !== "closed") await previous.context.close();
      ui.badge("STOPPED");
      ui.status(message);
    } catch (error) {
      report(error);
    } finally {
      busy = false;
      controls();
    }
  }

  async function start() {
    if (busy || session) return;
    const attempt = ++version;
    busy = true;
    controls();
    let context;
    try {
      context = new AudioContext();
      const oscillator = context.createOscillator();
      const filter = context.createBiquadFilter();
      const analyser = context.createAnalyser();
      const gain = context.createGain();
      filter.type = "lowpass";
      filter.Q.value = 0.7;
      analyser.fftSize = 512;
      gain.gain.value = 0;
      oscillator.connect(filter).connect(analyser).connect(gain).connect(context.destination);
      await context.resume();
      if (document.hidden || attempt !== version) {
        await context.close();
        ui.badge("STOPPED");
        ui.status("Playback cancelled. Press Start to listen again.");
        return;
      }
      if (context.state !== "running") throw new Error("The browser did not allow audio playback");
      const { shape, frequency, cutoff } = ui.settings();
      oscillator.type = shape;
      oscillator.frequency.value = Number(frequency);
      filter.frequency.value = Number(cutoff);
      oscillator.start();
      gain.gain.setTargetAtTime(OUTPUT_GAIN, context.currentTime, 0.02);
      session = { context, oscillator, filter, analyser, gain, samples: new Uint8Array(512) };
      context.onstatechange = () => {
        if (context.state !== "running") void end("Audio was interrupted. Press Start to listen again.");
      };
      ui.badge(`RUNNING / ${(context.sampleRate / 1000).toFixed(1)} kHz`);
      ui.status("Playing quietly. Change the shape or frequency, or press Stop.");
      draw();
    } catch (error) {
      if (context && context.state !== "closed") {
        try { await context.close(); } catch (closeError) { console.error("Web Audio cleanup:", closeError); }
      }
      session = undefined;
      stopTrace();
      report(error);
    } finally {
      busy = false;
      controls();
    }
  }

  const onMotion = () => { stopTrace(); if (session && !motion.matches) draw(); };
  const onHidden = () => {
    if (document.hidden) void end("Stopped because this tab was hidden. Press Start to listen again.");
  };
  const onPageHide = () => void end("Playback ended when leaving the page.");
  motion.addEventListener("change", onMotion);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onPageHide);

  const supported = typeof AudioContext !== "undefined";
  if (!supported) {
    ui.controls({ canStart: false, canStop: false });
    ui.badge("UNAVAILABLE");
    ui.status("This browser does not support the Web Audio API. You can still explore the lessons.");
  }

  return {
    supported,
    start,
    stop: () => end(),
    setShape(shape) {
      if (session) session.oscillator.type = shape;
    },
    // `node` is "oscillator" or "filter": the AudioNode whose frequency the control drives.
    setFrequency(node, value) {
      if (session) session[node].frequency.setTargetAtTime(Number(value), session.context.currentTime, 0.015);
    },
    // For an element removed from the page while sound is playing.
    dispose() {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      motion.removeEventListener?.("change", onMotion);
      return end("Stopped.");
    },
  };
}
