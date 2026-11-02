// Optional social publishing, the announcement model (epic #353, ADR 0308): the hosted half must
// accept and refuse exactly what crates/openblog-core/src/social_schedule.rs does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STATUSES,
  ScheduleError,
  canBecome,
  checkAuthorChange,
  checkCanonicalUrl,
  checkCaption,
  checkIdempotencyKey,
  checkTimeZone,
  editable,
  parseSchedule,
  providerOf,
  utcInstant,
} from "../../netlify/lib/social-schedule.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/social-schedule.json", import.meta.url), "utf8"));
const now = new Date(fixture.now);

const code = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ScheduleError, `a ScheduleError, got ${error}`);
    return error.code;
  }
  return "accepted";
};

test("providers match the fixture and an unsupported one fails explicitly", () => {
  for (const name of fixture.providers.accepted) assert.equal(providerOf(name).name, name);
  for (const name of fixture.providers.refused) assert.equal(code(() => providerOf(name)), "unsupported-provider", JSON.stringify(name));
});

test("captions match the fixture and are bounded in characters", () => {
  for (const provider of fixture.providers.accepted) {
    for (const [input, stored] of fixture.captions.accepted) assert.equal(checkCaption(provider, input), stored);
    for (const [input, expected] of fixture.captions.refused) assert.equal(code(() => checkCaption(provider, input)), expected, JSON.stringify(input));
    assert.equal(checkCaption(provider, "é".repeat(fixture.captionLimit)).length, fixture.captionLimit);
    assert.equal(code(() => checkCaption(provider, "😀".repeat(fixture.captionLimit))), "accepted", "limit counts code points, not UTF-16 units");
    assert.equal(code(() => checkCaption(provider, "a".repeat(fixture.captionLimit + 1))), "caption-too-long");
  }
  assert.equal(code(() => checkCaption("linkedin", "\ufeff")), "caption-characters");
});

test("schedule times match the fixture", () => {
  for (const [input, utc] of fixture.times.accepted) assert.equal(utcInstant(parseSchedule(input, now)), utc, input);
  for (const [input, expected] of fixture.times.refused) assert.equal(code(() => parseSchedule(input, now)), expected, JSON.stringify(input));
  assert.equal(code(() => parseSchedule(undefined, now)), "time-invalid");
});

test("time zones, keys and links match the fixture", () => {
  for (const zone of fixture.timeZones.accepted) assert.equal(checkTimeZone(zone), zone);
  for (const zone of fixture.timeZones.refused) assert.equal(code(() => checkTimeZone(zone)), "time-zone-invalid", JSON.stringify(zone));
  for (const key of fixture.keys.accepted) assert.equal(checkIdempotencyKey(key), key);
  for (const key of fixture.keys.refused) assert.equal(code(() => checkIdempotencyKey(key)), "key-invalid", JSON.stringify(key));
  for (const [url, work] of fixture.urls.accepted) assert.equal(checkCanonicalUrl(url, work), url);
  for (const [url, work] of fixture.urls.refused) assert.equal(code(() => checkCanonicalUrl(url, work)), "url-invalid", `${url} ${work}`);
});

test("statuses and transitions match the fixture", () => {
  assert.deepEqual([...STATUSES], fixture.statuses);
  const allowed = new Set(fixture.transitions.map(([from, to]) => `${from}>${to}`));
  for (const from of STATUSES) {
    assert.equal(editable(from), fixture.editable.includes(from));
    for (const to of STATUSES) assert.equal(canBecome(from, to), allowed.has(`${from}>${to}`), `${from} > ${to}`);
  }
  assert.equal(code(() => checkAuthorChange("scheduled", "canceled")), "accepted");
  for (const from of STATUSES.filter((status) => status !== "scheduled")) assert.equal(code(() => checkAuthorChange(from, "canceled")), "not-editable");
  assert.equal(code(() => checkAuthorChange("scheduled", "published")), "status-transition");
});

test("errors never repeat what was refused", () => {
  const secret = "x y sb_secret_should_not_echo";
  for (const fn of [() => parseSchedule(secret, now), () => checkTimeZone(secret), () => checkCaption("linkedin", `${secret}\u0007`), () => checkCanonicalUrl(secret, "/x/"), () => providerOf(secret)]) {
    try {
      fn();
      assert.fail("should refuse");
    } catch (error) {
      assert.ok(!String(error.message).includes("sb_secret"));
    }
  }
});
