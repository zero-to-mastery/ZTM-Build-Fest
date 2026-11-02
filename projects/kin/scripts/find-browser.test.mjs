import assert from "node:assert/strict";
import test from "node:test";
import { browserCandidates, browserInstallHint, findBrowser } from "./find-browser.mjs";

test("KIN_BROWSER wins over anything installed", async () => {
  assert.deepEqual(await findBrowser({ env: { KIN_BROWSER: "/opt/edge" }, exists: async () => true }), { executable: "/opt/edge", source: "KIN_BROWSER" });
});

test("the first installed browser for the platform is used", async () => {
  const linux = await findBrowser({ platform: "linux", env: {}, exists: async (path) => path === "/usr/bin/chromium" });
  assert.deepEqual(linux, { executable: "/usr/bin/chromium", source: "found" });
  const windows = browserCandidates({ platform: "win32", env: { "ProgramFiles(x86)": "C:\\PF86", ProgramFiles: "C:\\PF", LOCALAPPDATA: "C:\\Local" } });
  assert.ok(windows[0].endsWith("msedge.exe") && windows[0].startsWith("C:\\PF86"), "Edge in Program Files (x86) first, as on the CI runner");
  assert.ok(windows.some((path) => path.startsWith("C:\\Local") && path.endsWith("chrome.exe")), "a per-user Chrome too");
  const mac = browserCandidates({ platform: "darwin", env: { HOME: "/Users/sam" } });
  assert.ok(mac.includes("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
  assert.ok(mac.some((path) => path.startsWith("/Users/sam/Applications")));
  assert.equal(await findBrowser({ platform: "linux", env: {}, exists: async () => false }), null);
});

test("the install hint names something to install on each platform", () => {
  for (const platform of ["win32", "darwin", "linux"]) assert.match(browserInstallHint(platform), /KIN_BROWSER/);
  assert.match(browserInstallHint("linux"), /apt install/);
});
