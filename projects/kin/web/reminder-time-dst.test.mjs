import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("local reminder validation rejects the America/New_York spring DST gap", () => {
  // TZ is process startup state on some supported runtimes. Exercise the real
  // helper in a fresh process instead of mutating TZ in this test process.
  const script = `
    import assert from "node:assert/strict";
    import { resolveReminderTime } from "./web/reminder-time.js";
    const now = new Date(2027, 0, 1, 0, 0).getTime();
    const resolve = (date, time) => resolveReminderTime({ date, time, now });
    assert.equal(resolve("2027-02-10", "14:25").at, new Date(2027, 1, 10, 14, 25).getTime());
    assert.equal(resolve("2027-03-14", "02:30").error, "That date or time doesn't exist.");
    assert.equal(resolve("2027-03-14", "01:59").at, new Date(2027, 2, 14, 1, 59).getTime());
    assert.equal(resolve("2027-03-14", "03:00").at, new Date(2027, 2, 14, 3, 0).getTime());
    assert.equal(resolve("2027-02-30", "09:00").error, "That date or time doesn't exist.");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, TZ: "America/New_York" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
