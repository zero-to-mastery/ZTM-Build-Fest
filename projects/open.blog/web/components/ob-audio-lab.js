// <ob-audio-lab> is a small, real Web Audio synth: an oscillator through a low-pass filter and an
// analyser to a deliberately quiet output, with a live trace of the filtered signal. Sound plays
// only after the reader presses Start, and ends on Stop, when the tab is hidden, or when the
// element leaves the page. Children of the element are the no-JavaScript fallback. Nothing is
// recorded, stored or sent.
import { createSignalLab, WAVEFORMS, FLAT_TRACE, OUTPUT_GAIN } from "./ob-audio-core.js";
import { ObLab, defineLab, el, svgEl, field } from "./ob-lab.js";

const SIGNAL_PATH = ["Oscillator", "Low-pass filter", "Analyser", "Gain", "Output"];

class ObAudioLab extends ObLab {
  setup() {
    this.badge = el("strong", { class: "ob-audio-state" }, "NOT STARTED");
    this.status = el("p", { class: "ob-audio-status", role: "status" }, "Silent. Ready when you are.");

    this.shape = el("select");
    for (const [value, label] of WAVEFORMS) this.shape.append(el("option", { value }, label));
    this.frequency = el("input", { type: "range", min: "80", max: "880", step: "1", value: "220" });
    this.cutoff = el("input", { type: "range", min: "100", max: "6000", step: "10", value: "1200" });
    const frequencyField = field("Frequency", this.frequency, "ob-audio-field");
    const cutoffField = field("Low-pass cutoff", this.cutoff, "ob-audio-field");
    this.frequencyOut = el("output", { for: this.frequency.id }, "220 Hz");
    this.cutoffOut = el("output", { for: this.cutoff.id }, "1200 Hz");
    frequencyField.append(this.frequencyOut);
    cutoffField.append(this.cutoffOut);

    this.startButton = el("button", { type: "button" }, "Start sound");
    this.stopButton = el("button", { type: "button" }, "Stop sound");
    this.stopButton.disabled = true;

    this.path = svgEl("path", { class: "ob-audio-trace", d: FLAT_TRACE });
    const scope = svgEl("svg", { viewBox: "0 0 480 150", class: "ob-audio-scope", role: "img", "aria-label": "Live signal monitor: the oscillator after filtering, before the quiet output gain. Flat while silent; it stays flat if you prefer reduced motion." });
    scope.append(svgEl("path", { class: "ob-audio-axis", d: FLAT_TRACE }), this.path);

    const routing = el("ol", { class: "ob-audio-routing", "aria-label": "Signal path" });
    for (const stage of SIGNAL_PATH) routing.append(el("li", {}, stage));

    const controls = el("div", { class: "ob-audio-controls" });
    controls.append(
      field("Oscillator shape", this.shape, "ob-audio-field"),
      frequencyField, cutoffField,
      this.startButtonRow());

    this.append(
      el("p", { class: "ob-audio-note" }, `Start with your device volume low. This lab plays one quiet tone (output gain ${OUTPUT_GAIN}) only after you press Start; Stop, hiding the tab or leaving the page ends it. Nothing is recorded.`),
      this.badge, controls, this.status, scope, routing);

    this.lab = createSignalLab({
      settings: () => ({ shape: this.shape.value, frequency: this.frequency.value, cutoff: this.cutoff.value }),
      status: (text) => { this.status.textContent = text; },
      badge: (text) => { this.badge.textContent = text; },
      trace: (path) => this.path.setAttribute("d", path),
      controls: ({ canStart, canStop }) => {
        this.startButton.disabled = !canStart;
        this.stopButton.disabled = !canStop;
      },
    });

    this.startButton.addEventListener("click", () => this.lab.start());
    this.stopButton.addEventListener("click", () => void this.lab.stop());
    this.shape.addEventListener("change", () => this.lab.setShape(this.shape.value));
    for (const [input, output, node] of [
      [this.frequency, this.frequencyOut, "oscillator"],
      [this.cutoff, this.cutoffOut, "filter"],
    ]) {
      input.addEventListener("input", () => {
        output.textContent = `${input.value} Hz`;
        this.lab.setFrequency(node, input.value);
      });
    }
  }

  startButtonRow() {
    const row = el("div", { class: "ob-audio-transport" });
    row.append(this.startButton, this.stopButton);
    return row;
  }

  disconnectedCallback() {
    void this.lab?.dispose();
  }
}

defineLab("ob-audio-lab", ObAudioLab);
