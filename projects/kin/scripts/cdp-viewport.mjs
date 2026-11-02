// Sets a browser viewport over CDP and waits until the page reports it
// (issue #164). On the Windows runner, Emulation.setDeviceMetricsOverride can
// return before the page's layout viewport has changed, so a layout check
// right after it sometimes measured the previous width (for example 394px in
// a 320px check). Every browser runner sets viewports through this helper.
//
// `client` needs `send(method, params)` and `evaluate(expression)` returning
// the value, as the runners' CDP clients provide.
import { setTimeout as delay } from "node:timers/promises";

export const VIEWPORT_TIMEOUT_MS = 5_000;

export async function setViewport(client, metrics, { timeoutMs = VIEWPORT_TIMEOUT_MS } = {}) {
  const { width, height } = metrics;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height))
    throw new TypeError("setViewport needs an integer width and height.");
  await client.send("Emulation.setDeviceMetricsOverride", metrics);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      // Read directly, never via requestAnimationFrame: a background tab
      // gets no animation frames, so a frame wait there never resolves.
      last = await client.evaluate("({ width: innerWidth, height: innerHeight })");
    } catch (error) {
      // A navigation can drop the context while the page settles; keep waiting.
      if (!/Execution context was destroyed|Cannot find context with specified id/.test(error?.message ?? "")) throw error;
      last = null;
    }
    if (last?.width === width && last?.height === height) return last;
    if (Date.now() >= deadline)
      throw new Error(`The viewport did not reach ${width}x${height} within ${timeoutMs} ms; the page reports ${last ? `${last.width}x${last.height}` : "no size"}.`);
    await delay(50);
  }
}
