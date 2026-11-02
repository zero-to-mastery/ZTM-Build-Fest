import test from "node:test";
import assert from "node:assert/strict";
import { evolutionExamples, runExample } from "../../web/components/ob-evolution-model.js";
import { tracePath, FLAT_TRACE, WAVEFORMS, OUTPUT_GAIN } from "../../web/components/ob-audio-core.js";
import {
  detectSupport, motionSupportLabel, observerSupportLabel, popoverSupportLabel, motionReady, popoverReady,
  popoverToggled, layoutPlan, intersectionLabel, sizeLabel, PULSE_KEYFRAMES,
} from "../../web/components/ob-native-model.js";

test("every evolution example agrees with itself, and a disagreement is reported", async () => {
  assert.ok(evolutionExamples.length >= 3);
  for (const example of evolutionExamples) {
    const { before, after, same } = await runExample(example);
    assert.equal(same, true, example.label);
    assert.equal(before, after);
    assert.ok(example.before.trim() && example.after.trim() && example.caveat && example.context, example.label);
  }
  const broken = { ...evolutionExamples[0], newer: () => ["different"] };
  const result = await runExample(broken);
  assert.equal(result.same, false);
  assert.notEqual(result.before, result.after);
});

test("an example whose function throws rejects instead of reporting a match", async () => {
  await assert.rejects(runExample({ ...evolutionExamples[0], older: () => { throw new Error("boom"); } }), /boom/);
});

test("tracePath draws silence flat, scales samples around the centre and spans the width", () => {
  const silent = tracePath(new Uint8Array(512).fill(128));
  assert.match(silent, /^M0\.0 75\.0L/);
  assert.equal(silent.match(/[ML]/g).length, 240);
  assert.match(silent, /L480\.0 75\.0$/);
  const loud = tracePath(new Uint8Array(512).fill(255));
  assert.match(loud, /^M0\.0 138\.5L/);
  assert.equal(FLAT_TRACE, "M0 75H480");
});

test("the synth offers the four waveforms and a deliberately quiet fixed gain", () => {
  assert.deepEqual(WAVEFORMS.map(([value]) => value), ["sine", "triangle", "sawtooth", "square"]);
  assert.ok(OUTPUT_GAIN > 0 && OUTPUT_GAIN <= 0.05);
});

test("support detection reads capabilities from the environment and never assumes them", () => {
  const none = detectSupport({ document: {}, probe: {} });
  assert.deepEqual(none, { transitions: false, animations: false, popover: false, intersection: false, resize: false });
  const all = detectSupport({
    document: { startViewTransition() {} }, probe: { animate() {}, showPopover() {} },
    IntersectionObserver: class {}, ResizeObserver: class {},
  });
  assert.deepEqual(all, { transitions: true, animations: true, popover: true, intersection: true, resize: true });
  assert.equal(detectSupport({}).transitions, false);
});

test("readouts say plainly what is and is not supported", () => {
  assert.equal(motionSupportLabel({ transitions: true, animations: false }), "Transitions: yes / Animations: no");
  assert.equal(observerSupportLabel({ intersection: false, resize: true }), "Intersection: no / Resize: yes");
  assert.equal(popoverSupportLabel({ popover: false }), "Popover unavailable");
  assert.match(popoverReady({ popover: false }), /no imitation overlay/);
  assert.match(motionReady({ transitions: false }), /still work instantly/);
  assert.match(popoverToggled("open"), /top layer/);
  assert.match(popoverToggled("closed"), /left the top layer/);
});

test("a layout change uses a View Transition only when available and motion is allowed", () => {
  assert.equal(layoutPlan({ transitions: true }, false).transition, true);
  assert.equal(layoutPlan({ transitions: true }, true).transition, false);
  assert.match(layoutPlan({ transitions: true }, true).status, /without motion/);
  assert.equal(layoutPlan({ transitions: false }, false).transition, false);
  assert.match(layoutPlan({ transitions: false }, false).status, /unavailable/);
});

test("observer readouts round to whole numbers", () => {
  assert.equal(intersectionLabel(0.256), "26% visible in demo viewport");
  assert.equal(sizeLabel(300.4, 41.6), "300 × 42 CSS px");
  assert.equal(PULSE_KEYFRAMES.length, 3);
});
