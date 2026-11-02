// Waiting for a headless browser to be ready (#327).
//
// Every browser suite starts Chrome or Edge with --remote-debugging-port=0
// and reads the port from DevToolsActivePort in the profile. The suites used
// to poll for 10 s with the browser's output thrown away, so a slow start on
// a busy CI runner and a browser that crashed at once both ended as the same
// bare "Browser did not start". This waits longer, stops as soon as the
// browser has exited, and says which it was, with the end of its own error
// output.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** How long a browser may take to write its port. CI runners running several
 * jobs at once have taken more than 10 s. */
export const START_TIMEOUT_MS = 45_000;
const TAIL = 2_000;

/** spawn() options that keep the browser's error output for diagnostics. */
export const BROWSER_STDIO = Object.freeze({ windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });

/** The DevTools port from DevToolsActivePort's text, or null. */
export function devToolsPort(text) {
  const first = String(text ?? "").split("\n")[0].trim();
  return /^\d{1,5}$/.test(first) && Number(first) > 0 ? first : null;
}

/** Keeps the last part of a child's stderr; it is read continuously so the
 * pipe never fills and stalls the browser. */
export function captureStderr(child) {
  if (!child?.stderr) return () => "";
  if (child.kinStderr) return child.kinStderr;
  let tail = "";
  child.stderr.setEncoding?.("utf8");
  child.stderr.on("data", (chunk) => { tail = (tail + chunk).slice(-TAIL); });
  child.kinStderr = () => tail.trim();
  return child.kinStderr;
}

/**
 * Waits until `child` (a spawned browser using `profile` as its user data
 * directory) is ready, and returns its DevTools port. Throws with what is
 * known when it exits first or doesn't start in time.
 */
export async function waitForDevTools(child, profile, { label = "Browser", timeoutMs = START_TIMEOUT_MS, poll = 50 } = {}) {
  const stderr = captureStderr(child);
  let spawnError = null;
  child?.once?.("error", (error) => { spawnError = error; });
  const started = Date.now();
  const details = () => {
    const tail = stderr();
    return tail ? `; its last output: ${tail.split("\n").slice(-6).join(" | ")}` : "";
  };
  for (;;) {
    try {
      const port = devToolsPort(await readFile(join(profile, "DevToolsActivePort"), "utf8"));
      if (port) return port;
    } catch {
      // Not written yet.
    }
    const elapsed = Date.now() - started;
    if (spawnError) throw new Error(`${label} did not start: ${spawnError.message}`);
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error(`${label} did not start: it exited (code ${child.exitCode}, signal ${child.signalCode}) after ${elapsed} ms${details()}`);
    if (elapsed > timeoutMs)
      throw new Error(`${label} did not start within ${Math.round(timeoutMs / 1000)} s${details()}`);
    await delay(poll);
  }
}
