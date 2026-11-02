// Finds a Chromium-family browser for the browser suites (#331): KIN_BROWSER
// if set, else the first installed Edge, Chrome or Chromium in the usual
// places for this platform. The suites drive it through the DevTools
// protocol, so any of the three works; CI runs Edge on Windows and Chrome on
// Linux.
import { access, constants } from "node:fs/promises";
import { posix, win32 } from "node:path";

/** Where Edge, Chrome and Chromium are usually installed, in order. */
export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  // Paths in the described platform's own form, whichever machine asks.
  const join = platform === "win32" ? win32.join : posix.join;
  if (platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((root) => [
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  if (platform === "darwin") {
    const apps = ["/Applications", env.HOME && join(env.HOME, "Applications")].filter(Boolean);
    return apps.flatMap((root) => [
      join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      join(root, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
      join(root, "Chromium.app", "Contents", "MacOS", "Chromium"),
    ]);
  }
  return [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/snap/bin/chromium",
  ];
}

/** What to install, said for this platform. */
export function browserInstallHint(platform = process.platform) {
  if (platform === "win32") return "Install Microsoft Edge or Google Chrome, or set KIN_BROWSER to a Chromium-based browser's executable.";
  if (platform === "darwin") return "Install Google Chrome, Microsoft Edge or Chromium in /Applications, or set KIN_BROWSER to its executable (for example \"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\").";
  return "Install Google Chrome or Chromium (for example `sudo apt install chromium-browser`), or set KIN_BROWSER to its executable.";
}

const runnable = (path, platform) => access(path, platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false);

/** The browser to use: { executable, source } or null. */
export async function findBrowser({ platform = process.platform, env = process.env, exists = (path) => runnable(path, platform) } = {}) {
  if (env.KIN_BROWSER) return { executable: env.KIN_BROWSER, source: "KIN_BROWSER" };
  for (const candidate of browserCandidates({ platform, env })) {
    if (await exists(candidate)) return { executable: candidate, source: "found" };
  }
  return null;
}
