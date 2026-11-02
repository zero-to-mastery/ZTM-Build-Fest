// Sets the emulated media over CDP on top of a fixed light baseline (issue
// #795). Headless browsers follow the machine's own appearance, so on a
// computer in dark mode a check's "light" baseline was already dark and the
// dark-mode checks failed. Every regression tab starts light with forced
// colours off (applyRegressionDefaults), and a check that wants dark mode,
// forced colours or reduced motion asks for it here.
//
// Emulation.setEmulatedMedia replaces every emulated feature on each call: a
// feature left out goes back to the machine's setting, and a call without
// `media` drops an emulated media type such as print. So this always sends
// the baseline with the requested features laid over it, and
// `setMedia(client)` returns to the baseline.
//
// `client` needs `send(method, params)`, as the runners' CDP clients provide.
export const BASELINE_MEDIA_FEATURES = Object.freeze([
  Object.freeze({ name: "prefers-color-scheme", value: "light" }),
  Object.freeze({ name: "forced-colors", value: "none" }),
]);

export function mediaFeatures(features = []) {
  const merged = new Map(BASELINE_MEDIA_FEATURES.map(({ name, value }) => [name, value]));
  for (const { name, value } of features) merged.set(name, value);
  return [...merged].map(([name, value]) => ({ name, value }));
}

export async function setMedia(client, features = [], { media = "" } = {}) {
  await client.send("Emulation.setEmulatedMedia", { media, features: mediaFeatures(features) });
}
