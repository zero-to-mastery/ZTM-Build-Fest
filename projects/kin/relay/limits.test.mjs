// In-memory limits (#732): windows never outlive a day, the 30-day claim
// count keeps no address, and the bandwidth bucket.
import assert from "node:assert/strict";
import test from "node:test";
import { ClaimSketch, DAY, DEFAULT_LIMITS, HOUR, MINUTE, TokenBucket, WindowCounter, addressKey } from "./limits.mjs";

test("the ADR's defaults", () => {
  assert.equal(DEFAULT_LIMITS.connectionsPerName, 256);
  assert.equal(DEFAULT_LIMITS.connectionsPerClientPerMinute, 60);
  assert.equal(DEFAULT_LIMITS.phoneIdleMs, 15 * MINUTE);
  assert.equal(DEFAULT_LIMITS.bytesPerSecondPerName * 8, 20_000_000, "20 Mbit/s");
  assert.equal(DEFAULT_LIMITS.bytesPer30DaysPerName, 50e9, "50 GB per 30 days");
  assert.equal(DEFAULT_LIMITS.signInsPerSourcePerHour, 30);
  assert.equal(DEFAULT_LIMITS.claimsPerSourcePerDay, 3);
  assert.equal(DEFAULT_LIMITS.claimsPerSourcePer30Days, 10);
  assert.equal(DEFAULT_LIMITS.newNamesPerWeek, 20);
});

test("address keys: IPv4 as is, IPv6 by /64, mapped IPv4 as IPv4", () => {
  assert.equal(addressKey("203.0.113.7"), "203.0.113.7");
  assert.equal(addressKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(addressKey("2001:db8:1:2:aaaa::1"), addressKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
  assert.notEqual(addressKey("2001:db8:1:2::1"), addressKey("2001:db8:1:3::1"));
  assert.throws(() => addressKey("not an address"));
});

test("window counters forget an address as soon as its window ends, and never hold one past a day", () => {
  const clock = { now: 0 };
  const counter = new WindowCounter({ limit: 2, windowMs: MINUTE, now: () => clock.now });
  assert.ok(counter.hit("203.0.113.7"));
  assert.ok(counter.hit("203.0.113.7"));
  assert.equal(counter.allows("203.0.113.7"), false);
  assert.equal(counter.hit("203.0.113.7"), false);
  assert.ok(counter.hit("198.51.100.1"));
  clock.now += MINUTE;
  assert.ok(counter.allows("203.0.113.7"));
  counter.sweep();
  assert.equal(counter.size, 0, "nothing kept after the window");
  const daily = new WindowCounter({ limit: 3, windowMs: DAY, now: () => clock.now });
  daily.hit("203.0.113.7");
  clock.now += DAY - 1;
  daily.sweep();
  assert.deepEqual(daily.keys(), ["203.0.113.7"]);
  clock.now += 1;
  daily.sweep();
  assert.deepEqual(daily.keys(), [], "forgotten after 24 hours at most");
  assert.throws(() => new WindowCounter({ limit: 1, windowMs: DAY + 1 }), RangeError);
});

test("the 30-day claim sketch counts per source without keeping one", () => {
  const clock = { now: 0 };
  const sketch = new ClaimSketch({ limit: 10, now: () => clock.now });
  for (let day = 0; day < 10; day += 1) {
    assert.ok(sketch.allows("203.0.113.7"), `day ${day}`);
    sketch.add("203.0.113.7");
    clock.now += DAY;
  }
  assert.equal(sketch.allows("203.0.113.7"), false, "ten in 30 days");
  assert.ok(sketch.allows("198.51.100.1"), "another source is unaffected");
  clock.now += 21 * DAY;
  assert.ok(sketch.allows("203.0.113.7"), "the oldest claim has aged out");
  // What it holds is counts in cells, not addresses or hashes of them.
  const state = JSON.stringify(Object.entries(sketch));
  assert.ok(!state.includes("203.0.113"));
});

test("the bandwidth bucket allows a burst and then the sustained rate", () => {
  const clock = { now: 0 };
  const bucket = new TokenBucket({ bytesPerSecond: 1000, burstBytes: 2000, now: () => clock.now });
  assert.equal(bucket.reserve(2000), 0);
  assert.equal(bucket.reserve(500), 500, "half a second of debt");
  clock.now += 500;
  assert.equal(bucket.reserve(0), 0);
  clock.now += 10 * HOUR;
  assert.equal(bucket.reserve(2000), 0, "refills only up to the burst");
  assert.equal(bucket.reserve(1), 1);
});
