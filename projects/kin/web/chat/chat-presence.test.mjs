// Read receipts and typing (#120, #121, #122): the cursor rules, the sealed
// receipt slot, and typing frames, with real crypto and a fake service and clock.
import assert from "node:assert/strict";
import test from "node:test";
import { exportDevicePublicKeys, generateDeviceKeys, generateHouseholdKey } from "../sync/crypto.js";
import {
  ChatPresence, ONLINE_BEAT_MS, ONLINE_EXPIRE_MS, OnlineTracker, RECEIPT_WRITE_MS, TYPING_EXPIRE_MS, TYPING_SEND_MS, TypingTracker, compareCursors, cursorOf, hasRead, mergeCursors, readersOf,
  seenText, typingText,
} from "./chat-presence.js";

const HOUSEHOLD = "aa".repeat(16);
const id = (n) => n.toString(16).padStart(2, "0").repeat(16);
const ME = id(1), SAM = id(2), ALEX = id(3);
/** Messages in posting order: message n was posted at 1000 + n. */
const message = (n, authorId = SAM) => ({ messageId: id(0x10 + n), postedAt: 1000 + n, authorId });

test("cursors order by time then ID, only move forward, and converge in any order", () => {
  const [m1, m2, m3] = [1, 2, 3].map((n) => cursorOf(message(n)));
  assert.ok(compareCursors(m1, m2) < 0 && compareCursors(m3, m2) > 0 && compareCursors(m2, m2) === 0);
  assert.ok(compareCursors(null, m1) < 0 && compareCursors(m1, null) > 0 && compareCursors(null, null) === 0);
  // The same instant: the ID breaks the tie, the same way on every device.
  const a = { postedAt: 5, messageId: id(1) }, b = { postedAt: 5, messageId: id(2) };
  assert.ok(compareCursors(a, b) < 0);
  for (const [x, y] of [[m1, m2], [m3, m1], [null, m2], [m2, null], [a, b]])
    assert.deepEqual(mergeCursors(x, y), mergeCursors(y, x), "order doesn't matter");
  assert.deepEqual(mergeCursors(m3, m1), m3, "never backwards");
  assert.equal(mergeCursors(null, null), null);
});

test("a member has read the messages at or before their cursor, whatever those became", () => {
  const cursor = cursorOf(message(5));
  assert.equal(hasRead(cursor, message(4)), true);
  assert.equal(hasRead(cursor, message(5)), true, "up to and including");
  assert.equal(hasRead(cursor, message(6)), false);
  assert.equal(hasRead(null, message(1)), false);
  const slots = new Map([
    [ME, { cursor: cursorOf(message(5)), readAt: 300 }],
    [ALEX, { cursor: cursorOf(message(2)), readAt: 100 }],
    [SAM, { cursor: cursorOf(message(9)), readAt: 200 }],
  ]);
  assert.deepEqual(readersOf(message(1, SAM), slots), [{ memberId: ALEX, readAt: 100 }, { memberId: ME, readAt: 300 }], "not its author, earliest first");
  assert.deepEqual(readersOf(message(4, SAM), slots), [{ memberId: ME, readAt: 300 }]);
  assert.deepEqual(readersOf(message(7, ME), slots), [{ memberId: SAM, readAt: 200 }], "my own message: others only");
});

test("the lines say who", () => {
  assert.equal(seenText([], false), "");
  assert.equal(seenText(["Sam", "Alex"], false), "Seen by Sam, Alex");
  assert.equal(seenText(["Sam", "Alex"], true), "Seen by everyone");
  assert.equal(typingText([]), "");
  assert.equal(typingText(["Sam"]), "Sam is typing…");
  assert.equal(typingText(["Sam", "Alex"]), "Sam and Alex are typing…");
  assert.equal(typingText(["A", "B", "C"]), "A, B and C are typing…");
  assert.equal(typingText(["A", "B", "C", "D"]), "Several people are typing…");
});

test("typing runs out, and is refreshed by more typing", () => {
  let now = 0;
  const tracker = new TypingTracker({ now: () => now });
  tracker.set("sam", true);
  now = 5_999;
  assert.deepEqual(tracker.active(), ["sam"]);
  tracker.set("sam", true);
  now = 11_000;
  assert.deepEqual(tracker.active(), ["sam"], "refreshed at 5.999 s");
  now = 12_000;
  assert.deepEqual(tracker.active(), [], "gone 6 s after the last one");
  tracker.set("alex", true);
  tracker.set("alex", false);
  assert.deepEqual(tracker.active(), [], "stopped at once");
  assert.equal(tracker.nextExpiry(), null);
});

/* ---------- The presence, with a fake household ---------- */

async function household() {
  const key = await generateHouseholdKey();
  const make = async (deviceId, memberId) => {
    const keys = await generateDeviceKeys();
    const publicKeys = await exportDevicePublicKeys(keys);
    return { keys, entry: { deviceId, memberId, publicKeys, verifiedKeyHistory: [{ publicKeys }] } };
  };
  const people = { phone: await make(id(0x21), ME), laptop: await make(id(0x22), ME), sam: await make(id(0x23), SAM), alex: await make(id(0x24), ALEX) };
  const directory = Object.values(people).map(({ entry }) => entry);
  const clock = { now: 1_000_000, timers: [] };
  const fake = {
    clock,
    setTimer: (callback, ms) => { const timer = { callback, at: clock.now + ms }; clock.timers.push(timer); return timer; },
    clearTimer: (timer) => { clock.timers = clock.timers.filter((entry) => entry !== timer); },
    /** Moves time on, running timers that come due. */
    async advance(ms) {
      const until = clock.now + ms;
      for (;;) {
        const next = clock.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock.timers = clock.timers.filter((timer) => timer !== next);
        clock.now = Math.max(clock.now, next.at);
        await next.callback();
        await settleTasks();
      }
      clock.now = until;
    },
  };
  // The service: one slot per member, compare-and-set, as the real one.
  const slots = new Map();
  const log = [];
  const service = (deviceId) => async (path, options = {}) => {
    const member = directory.find((entry) => entry.deviceId === deviceId).memberId;
    if (path !== "/api/chat/receipts") throw new Error(`unexpected ${path}`);
    if (options.method === "PUT") {
      const body = JSON.parse(options.body);
      log.push({ deviceId, expectedRevision: body.expectedRevision });
      if ((slots.get(member)?.revision ?? 0) !== body.expectedRevision)
        throw Object.assign(new Error("stale"), { code: "chat_receipts_stale" });
      if (body.record.deviceId !== deviceId || body.record.deviceSequence !== body.expectedRevision + 1) throw Object.assign(new Error("invalid"), { code: "chat_receipts_invalid" });
      slots.set(member, { revision: body.expectedRevision + 1, record: structuredClone(body.record) });
      return { revision: body.expectedRevision + 1 };
    }
    log.push({ deviceId, read: true });
    return { slots: [...slots].map(([memberId, row]) => ({ memberId, ...structuredClone(row) })) };
  };
  const presences = new Map();
  running = presences;
  const frames = [];
  const open = (name, { liveUp = true } = {}) => {
    const who = people[name];
    const saved = { value: null };
    const changes = [];
    const presence = new ChatPresence({
      identity: { householdId: HOUSEHOLD, memberId: who.entry.memberId, deviceId: who.entry.deviceId },
      request: service(who.entry.deviceId),
      epochKey: async () => key,
      sendingEpoch: async () => 1,
      signingKey: () => who.keys.signingPrivateKey,
      devices: () => directory,
      sendLive: (bytes, kind = "typing") => { if (!liveUp) return false; frames.push({ from: name, bytes, kind }); return true; },
      store: { presence: async () => saved.value, savePresence: async (value) => { saved.value = structuredClone(value); } },
      now: () => clock.now,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
      onChange: () => changes.push(clock.now),
    });
    presences.set(name, presence);
    return Object.assign(presence, { saved, changes });
  };
  /** Delivers the typing frames sent so far to the other devices. */
  const deliver = async (to) => {
    for (const frame of frames.splice(0)) {
      for (const [name, presence] of presences) {
        if (name === frame.from || (to && !to.includes(name))) continue;
        await (frame.kind === "presence" ? presence.receiveOnline(frame.bytes) : presence.receiveTyping(frame.bytes));
      }
    }
  };
  return { ...fake, people, directory, slots, log, open, frames, deliver, key };
}

/** Lets sealing, sending and the writes in flight finish (they use real crypto). */
let running = new Map();
async function settleTasks() {
  for (let round = 0; round < 3; round += 1) {
    await Promise.all([...running.values()].flatMap((presence) => [presence.writing, presence.typingChain, presence.onlineChain]));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("reading on two devices of one member marks it read for the member once, never backwards", async () => {
  const h = await household();
  const phone = h.open("phone"), laptop = h.open("laptop"), sam = h.open("sam");
  await Promise.all([phone.load(), laptop.load(), sam.load()]);
  phone.markRead(message(5));
  await h.advance(RECEIPT_WRITE_MS);
  assert.equal(h.slots.get(ME).revision, 1);
  // The laptop read less far; it merges rather than lowering the cursor.
  laptop.markRead(message(3));
  await h.advance(RECEIPT_WRITE_MS);
  assert.equal(h.slots.size, 1, "one slot for the member, however many devices");
  await laptop.refresh();
  assert.deepEqual(laptop.cursor, cursorOf(message(5)), "the laptop took the later cursor");
  // Reading further on the laptop moves it forward for the phone too.
  laptop.markRead(message(8));
  await h.advance(RECEIPT_WRITE_MS);
  await phone.refresh();
  assert.deepEqual(phone.cursor, cursorOf(message(8)));
  // Marking something already covered changes nothing and writes nothing.
  const writes = h.log.filter((entry) => entry.expectedRevision !== undefined).length;
  assert.equal(phone.markRead(message(2)), false);
  await h.advance(10_000);
  assert.equal(h.log.filter((entry) => entry.expectedRevision !== undefined).length, writes);
  // Another member sees me as having read up to 8, and by message.
  await sam.refresh();
  assert.deepEqual(sam.readers(message(6, SAM)).map((reader) => reader.memberId), [ME]);
  assert.deepEqual(sam.readers(message(9, SAM)), []);
});

test("writes are throttled to one per 2 seconds however much is read", async () => {
  const h = await household();
  const phone = h.open("phone");
  await phone.load();
  const writes = () => h.log.filter((entry) => entry.expectedRevision !== undefined).length;
  for (let n = 1; n <= 20; n += 1) phone.markRead(message(n));
  await h.advance(1_000);
  assert.equal(writes(), 1, "twenty reads in a burst: one write, of where it got to");
  assert.deepEqual(phone.cursor, cursorOf(message(20)));
  phone.markRead(message(21));
  phone.markRead(message(22));
  await h.advance(500);
  assert.equal(writes(), 1, "the next one waits for the 2 second window");
  await h.advance(500);
  assert.equal(writes(), 2);
  await h.advance(10_000);
  assert.equal(writes(), 2, "and nothing more is sent when nothing changed");
});

test("the slot is sealed: the service sees neither the cursor nor the settings", async () => {
  const h = await household();
  const phone = h.open("phone");
  await phone.load();
  phone.markRead(message(4));
  await h.advance(RECEIPT_WRITE_MS);
  const stored = JSON.stringify(h.slots.get(ME).record);
  assert.equal(stored.includes(message(4).messageId), false);
  assert.equal(stored.includes("cursor") || stored.includes("receipts") || stored.includes("typing"), false);
  assert.ok(h.slots.get(ME).record.ciphertext.length > 20);
  assert.ok(Buffer.byteLength(stored) < 4096);
});

test("turning receipts off clears my cursor, sends none, hides everyone else's, on all my devices", async () => {
  const h = await household();
  const phone = h.open("phone"), laptop = h.open("laptop"), sam = h.open("sam");
  await Promise.all([phone.load(), laptop.load(), sam.load()]);
  sam.markRead(message(6, ME));
  phone.markRead(message(5));
  await h.advance(RECEIPT_WRITE_MS);
  await Promise.all([phone.refresh(), sam.refresh(), laptop.refresh()]);
  assert.equal(phone.readers(message(1, ME)).length, 1, "I see Sam's");
  assert.equal(sam.readers(message(4, SAM)).length, 1, "Sam sees mine on his message");
  assert.equal(sam.readers(message(4, ALEX)).length, 1, "and on anyone else's");
  await phone.setSettings({ receipts: false });
  assert.equal(phone.cursor, null, "my progress is cleared, not just hidden");
  assert.equal(phone.markRead(message(9)), false, "and not collected while off");
  assert.deepEqual(phone.readers(message(1, ME)), [], "reciprocity: I stop seeing theirs");
  await h.advance(RECEIPT_WRITE_MS);
  await sam.refresh();
  assert.deepEqual(sam.readers(message(4, ALEX)), [], "Sam no longer sees me");
  // My other device follows the setting from the slot.
  await laptop.refresh();
  assert.equal(laptop.sendsReceipts, false);
  assert.equal(laptop.cursor, null);
  assert.deepEqual(laptop.readers(message(1, ME)), []);
  assert.equal(laptop.markRead(message(9)), false);
  // Turning it back on resumes from now: the old cursor is gone.
  await laptop.setSettings({ receipts: true });
  assert.equal(laptop.cursor, null);
  laptop.markRead(message(7));
  await h.advance(RECEIPT_WRITE_MS);
  await phone.refresh();
  assert.equal(phone.sendsReceipts, true, "on again, everywhere");
  assert.deepEqual(phone.cursor, cursorOf(message(7)));
});

test("the settings that were written last win, wherever they were set", async () => {
  const h = await household();
  const phone = h.open("phone"), laptop = h.open("laptop");
  await Promise.all([phone.load(), laptop.load()]);
  await phone.setSettings({ typing: false });
  h.clock.now += 5_000;
  await laptop.refresh();
  assert.equal(laptop.sendsTyping, false);
  h.clock.now += 5_000;
  await laptop.setSettings({ typing: true });
  await phone.refresh();
  assert.equal(phone.sendsTyping, true);
  assert.equal(phone.sendsReceipts, true, "the other setting is untouched");
});

test("a slot signed by a device that isn't its member's is ignored", async () => {
  const h = await household();
  const alex = h.open("alex"), phone = h.open("phone");
  await Promise.all([alex.load(), phone.load()]);
  alex.markRead(message(9, ME));
  await h.advance(RECEIPT_WRITE_MS);
  // The service files Alex's slot under Sam's name.
  h.slots.set(SAM, h.slots.get(ALEX));
  h.slots.delete(ALEX);
  await phone.refresh();
  assert.equal(phone.readers(message(1, ME)).length, 0, "Alex's device can't speak for Sam");
});

test("a change made while a write is in flight is not lost", async () => {
  const h = await household();
  const phone = h.open("phone"), sam = h.open("sam");
  await Promise.all([phone.load(), sam.load()]);
  const request = phone.env.request;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const inFlight = new Promise((resolve) => { entered = resolve; });
  phone.env.request = async (path, options = {}) => {
    if (options.method === "PUT") { entered(); await gate; }
    return request(path, options);
  };
  phone.markRead(message(5));
  const first = phone.flush();
  await inFlight;
  const turnedOff = phone.setSettings({ receipts: false });
  release();
  await Promise.all([first, turnedOff]);
  await settleTasks();
  assert.equal(phone.dirty, false);
  assert.equal(phone.revision, 2, "the change got its own write");
  await sam.refresh();
  assert.equal(sam.readers(message(3, SAM)).length, 0, "nothing of what was read is left");
});

test("a device that can't open my member's slot sends nothing until it knows the settings", async () => {
  const h = await household();
  const phone = h.open("phone"), laptop = h.open("laptop");
  await Promise.all([phone.load(), laptop.load()]);
  await phone.setSettings({ typing: false });
  // The laptop joined after a key change: the slot is sealed under a key it never had.
  laptop.env.epochKey = async (epoch) => { if (epoch === 1) throw new Error("no key for this epoch"); return h.key; };
  laptop.env.sendingEpoch = async () => 2;
  await laptop.refresh();
  assert.equal(laptop.sendsTyping, false, "fails closed");
  assert.equal(laptop.sendsReceipts, false);
  laptop.typed();
  await settleTasks();
  assert.equal(h.frames.length, 0, "no typing from a device that doesn't know");
  assert.equal(laptop.markRead(message(3)), false);
  const before = h.log.filter((entry) => entry.deviceId === laptop.env.identity.deviceId && entry.expectedRevision !== undefined).length;
  h.clock.now += 5_000;
  await laptop.setSettings({ typing: false });
  const writes = h.log.filter((entry) => entry.deviceId === laptop.env.identity.deviceId && entry.expectedRevision !== undefined);
  assert.equal(writes.length - before, 1, "knew the revision, so no conflict");
  assert.equal(writes.at(-1).expectedRevision, 1);
  assert.equal(laptop.sendsReceipts, true);
  assert.equal(laptop.sendsTyping, false);
});

test("a device that was away while receipts went off and on doesn't publish what was cleared", async () => {
  const h = await household();
  const phone = h.open("phone"), laptop = h.open("laptop"), sam = h.open("sam");
  await Promise.all([phone.load(), laptop.load(), sam.load()]);
  phone.markRead(message(5));
  await h.advance(RECEIPT_WRITE_MS);
  await laptop.refresh();
  assert.deepEqual(laptop.cursor, cursorOf(message(5)));
  await phone.setSettings({ receipts: false });
  h.clock.now += 5_000;
  await phone.setSettings({ receipts: true });
  await laptop.refresh();
  assert.equal(laptop.cursor, null, "takes the slot's progress with its newer settings");
  await h.advance(RECEIPT_WRITE_MS);
  await sam.refresh();
  assert.equal(sam.readers(message(1, SAM)).length, 0);
});

test("settings set at the same instant on two devices agree, the more private one winning", async () => {
  const h = await household();
  const phone = h.open("phone"), laptop = h.open("laptop");
  await Promise.all([phone.load(), laptop.load()]);
  await phone.setSettings({ typing: false });
  await laptop.setSettings({ receipts: false });
  await phone.refresh();
  await laptop.refresh();
  await settleTasks();
  for (const device of [phone, laptop]) {
    assert.equal(device.sendsReceipts, false);
    assert.equal(device.sendsTyping, false);
  }
});

test("a message dated far in the future doesn't move the cursor", async () => {
  const h = await household();
  const phone = h.open("phone");
  await phone.load();
  assert.equal(phone.markRead({ ...message(1), postedAt: h.clock.now + 10 * 60_000 }), false);
  assert.equal(phone.cursor, null);
  assert.equal(phone.markRead({ ...message(2), postedAt: h.clock.now + 60_000 }), true, "a minute of clock difference is fine");
});

test("a rolled-back or garbled slot never lowers what is known", async () => {
  const h = await household();
  const phone = h.open("phone"), sam = h.open("sam");
  await Promise.all([phone.load(), sam.load()]);
  phone.markRead(message(5));
  await h.advance(RECEIPT_WRITE_MS);
  await sam.refresh();
  const first = structuredClone(h.slots.get(ME));
  phone.markRead(message(8));
  await h.advance(RECEIPT_WRITE_MS);
  await sam.refresh();
  assert.equal(sam.readers(message(7, SAM)).length, 1);
  h.slots.set(ME, first);
  await sam.refresh();
  assert.equal(sam.readers(message(7, SAM)).length, 1, "an older revision is not trusted over a newer one seen");
  h.slots.set(ME, { revision: 9, record: { ...first.record, ciphertext: "AAAA" } });
  await sam.refresh();
  assert.equal(sam.readers(message(7, SAM)).length, 0, "an unreadable slot shows nothing, and breaks nothing");
});

test("two devices writing at once both end up in the slot", async () => {
  const h = await household();
  const phone = h.open("phone"), laptop = h.open("laptop");
  await Promise.all([phone.load(), laptop.load()]);
  phone.markRead(message(4));
  laptop.markRead(message(6));
  await h.advance(RECEIPT_WRITE_MS);
  await Promise.all([phone.refresh(), laptop.refresh()]);
  assert.deepEqual(phone.cursor, cursorOf(message(6)));
  assert.deepEqual(laptop.cursor, cursorOf(message(6)));
  assert.ok(h.log.some((entry) => entry.expectedRevision === 1), "the loser re-read and tried again");
});

test("the cursor and settings survive a reload on this device", async () => {
  const h = await household();
  const phone = h.open("phone");
  await phone.load();
  await phone.setSettings({ typing: false });
  phone.markRead(message(5));
  const saved = structuredClone(phone.saved.value);
  const again = h.open("phone");
  again.saved.value = saved;
  await again.load();
  assert.equal(again.sendsTyping, false);
  assert.deepEqual(again.cursor, cursorOf(message(5)));
});

/* ---------- Typing ---------- */

test("typing reaches the others sealed, expires after 6 seconds, and stops at once when stopped", async () => {
  const h = await household();
  const sam = h.open("sam"), phone = h.open("phone"), alex = h.open("alex");
  await Promise.all([sam.load(), phone.load(), alex.load()]);
  sam.typed();
  await settleTasks();
  assert.equal(h.frames.length, 1);
  const text = new TextDecoder().decode(h.frames[0].bytes);
  assert.equal(text.includes("typing") || text.includes(SAM), false, "nothing readable in the frame");
  await h.deliver();
  assert.deepEqual(phone.typing(), [SAM]);
  assert.deepEqual(alex.typing(), [SAM]);
  assert.deepEqual(sam.typing(), [], "not my own");
  // Typing more refreshes it.
  await h.advance(3_000);
  sam.typed();
  await settleTasks();
  await h.deliver();
  await h.advance(5_000);
  assert.deepEqual(phone.typing(), [SAM], "refreshed at 3 s, so there at 8 s");
  // Silence: gone within 6 seconds of the last frame.
  await h.advance(TYPING_EXPIRE_MS);
  assert.deepEqual(phone.typing(), []);
  assert.ok(phone.changes.length >= 2, "the view is told when it expires");
  // Stopping removes it at once.
  sam.typed();
  await settleTasks();
  await h.deliver();
  assert.deepEqual(phone.typing(), [SAM]);
  sam.stopTyping();
  await settleTasks();
  await h.deliver();
  assert.deepEqual(phone.typing(), []);
});

test("typing is sent at most every 3 seconds and nothing is sent when it is off", async () => {
  const h = await household();
  const sam = h.open("sam");
  await sam.load();
  for (let key = 0; key < 20; key += 1) sam.typed();
  await settleTasks();
  assert.equal(h.frames.length, 1, "one frame for twenty keystrokes");
  await h.advance(TYPING_SEND_MS - 1);
  sam.typed();
  await settleTasks();
  assert.equal(h.frames.length, 1);
  await h.advance(1);
  sam.typed();
  await settleTasks();
  assert.equal(h.frames.length, 2);
  await sam.setSettings({ typing: false });
  await settleTasks();
  const stopped = h.frames.length;
  assert.equal(stopped, 3, "turning it off stops the indicator now");
  await h.advance(10_000);
  sam.typed();
  sam.typed();
  await settleTasks();
  assert.equal(h.frames.length, stopped, "and sends nothing more");
  // Off for me doesn't stop me seeing others'.
  const phone = h.open("phone");
  await phone.load();
  await phone.setSettings({ typing: false });
  const alex = h.open("alex");
  await alex.load();
  await alex.setSettings({ typing: true });
  alex.typed();
  await settleTasks();
  await h.deliver(["phone"]);
  assert.deepEqual(phone.typing(), [ALEX]);
});

test("a frame that is replayed, forged, from nobody, or from myself shows nothing", async () => {
  const h = await household();
  const sam = h.open("sam"), phone = h.open("phone"), laptop = h.open("laptop");
  await Promise.all([sam.load(), phone.load(), laptop.load()]);
  sam.typed();
  await settleTasks();
  const [{ bytes }] = h.frames;
  h.frames.length = 0;
  assert.equal(await phone.receiveTyping(bytes), true);
  assert.equal(await phone.receiveTyping(bytes), false, "the same frame again");
  // A flipped bit in the ciphertext fails the signature.
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  const forged = { ...envelope, deviceSequence: envelope.deviceSequence + 1, ciphertext: envelope.ciphertext.slice(0, -2) + (envelope.ciphertext.endsWith("AA") ? "BB" : "AA") };
  assert.equal(await phone.receiveTyping(new TextEncoder().encode(JSON.stringify(forged))), false);
  // A device nobody knows.
  assert.equal(await phone.receiveTyping(new TextEncoder().encode(JSON.stringify({ ...envelope, deviceId: id(0x77), deviceSequence: envelope.deviceSequence + 5 }))), false);
  // Garbage.
  assert.equal(await phone.receiveTyping(new Uint8Array([1, 2, 3])), false);
  // My other device's own typing isn't shown to me.
  phone.typed();
  await settleTasks();
  assert.equal(await laptop.receiveTyping(h.frames[0].bytes), false);
  assert.deepEqual(laptop.typing(), []);
});

test("typing is only sent while the live channel is up, and a closed presence shows nothing", async () => {
  const h = await household();
  const down = h.open("sam", { liveUp: false });
  await down.load();
  down.typed();
  await settleTasks();
  assert.equal(h.frames.length, 0);
  assert.equal(down.typingOn, false, "nothing was sent, so there's nothing to stop");
  const phone = h.open("phone");
  await phone.load();
  const sam = h.open("alex");
  await sam.load();
  sam.typed();
  await settleTasks();
  phone.close();
  assert.equal(await phone.receiveTyping(h.frames[0].bytes), false);
  assert.deepEqual(phone.typing(), []);
  phone.markRead(message(3));
  assert.equal(phone.cursor, null);
});

test("a typing frame sealed long ago shows nothing, even if it was never seen before", async () => {
  const h = await household();
  const sam = h.open("sam"), phone = h.open("phone");
  await Promise.all([sam.load(), phone.load()]);
  sam.typed();
  await settleTasks();
  const [{ bytes }] = h.frames;
  h.frames.length = 0;
  h.clock.now += 60_000;
  assert.equal(await phone.receiveTyping(bytes), false, "a minute old");
  assert.deepEqual(phone.typing(), []);
});

test("a device that doesn't know the settings never writes its defaults over them", async () => {
  const h = await household();
  const phone = h.open("phone"), laptop = h.open("laptop"), sam = h.open("sam");
  await Promise.all([phone.load(), laptop.load(), sam.load()]);
  laptop.markRead(message(4)); // dirty with default settings, before any refresh
  await phone.setSettings({ receipts: false });
  laptop.env.epochKey = async (epoch) => { if (epoch === 1) throw new Error("no key"); return h.key; };
  await laptop.refresh();
  assert.equal(laptop.unverified, true);
  await h.advance(RECEIPT_WRITE_MS * 3);
  assert.equal(h.slots.get(ME).revision, 1, "the phone's slot was left alone");
  await sam.refresh();
  assert.equal(sam.readers(message(2, SAM)).length, 0);
  // The key arrives: the slot opens, the settings are adopted, nothing stays silenced.
  laptop.env.epochKey = async () => h.key;
  await laptop.refresh();
  assert.equal(laptop.unverified, false);
  assert.equal(laptop.sendsReceipts, false, "adopts the phone's choice");
  assert.equal(laptop.cursor, null);
});

test("another member's slot that fails only for a missing key keeps its reader", async () => {
  const h = await household();
  const sam = h.open("sam"), phone = h.open("phone");
  await Promise.all([sam.load(), phone.load()]);
  sam.markRead(message(9, ME));
  await h.advance(RECEIPT_WRITE_MS);
  await phone.refresh();
  assert.equal(phone.readers(message(1, ME)).length, 1);
  phone.env.epochKey = async () => { throw new Error("key not here right now"); };
  await phone.refresh();
  assert.equal(phone.readers(message(1, ME)).length, 1, "kept");
});

test("a slot cursor dated far ahead is read as none", async () => {
  const h = await household();
  const sam = h.open("sam"), phone = h.open("phone");
  await Promise.all([sam.load(), phone.load()]);
  sam.cursor = { postedAt: h.clock.now + 60 * 60_000, messageId: id(0x99) };
  sam.touch();
  await sam.flush();
  await phone.refresh();
  assert.equal(phone.readers(message(1, ME)).length, 0);
});

test("a device is online while it heartbeats, a member while any device is, and none of it is kept (#128)", async () => {
  const h = await household();
  const sam = h.open("sam"), phone = h.open("phone"), laptop = h.open("laptop"), alex = h.open("alex");
  await Promise.all([sam.load(), phone.load(), laptop.load(), alex.load()]);
  sam.setActive(true);
  await settleTasks();
  assert.equal(h.frames.length, 1);
  assert.equal(h.frames[0].kind, "presence");
  assert.equal(new TextDecoder().decode(h.frames[0].bytes).includes(SAM), false, "nothing readable in the frame");
  await h.deliver();
  assert.deepEqual(phone.online(), [SAM]);
  assert.deepEqual(alex.online(), [SAM]);
  assert.deepEqual(sam.online(), [], "not myself");
  // A heartbeat every 30 seconds keeps it going.
  for (let round = 0; round < 4; round += 1) {
    await h.advance(ONLINE_BEAT_MS);
    await settleTasks();
    await h.deliver();
  }
  assert.deepEqual(alex.online(), [SAM], "still here after two minutes");
  // Connection lost (no frames arrive): gone within 70 seconds of the last one.
  h.frames.splice(0);
  await h.advance(ONLINE_EXPIRE_MS - 1);
  assert.deepEqual(alex.online(), [SAM]);
  await h.advance(1);
  assert.deepEqual(alex.online(), []);
  assert.ok(alex.changes.length >= 2, "the view is told when it runs out");
  // Two devices of one member: online until both are away.
  sam.setActive(false);
  await settleTasks();
  h.frames.splice(0);
  phone.setActive(true);
  laptop.setActive(true);
  await settleTasks();
  await h.deliver(["alex"]);
  assert.deepEqual(alex.online(), [ME]);
  phone.setActive(false);
  await settleTasks();
  await h.deliver(["alex"]);
  assert.deepEqual(alex.online(), [ME], "the laptop is still here");
  laptop.setActive(false);
  await settleTasks();
  await h.deliver(["alex"]);
  assert.deepEqual(alex.online(), [], "away at once, not after 70 seconds");
  // Nothing about it reaches the stored state.
  assert.equal(JSON.stringify(alex.saved.value ?? {}).includes(SAM), false);
  assert.equal(JSON.stringify([...h.slots.values()]).includes("online\":["), false);
});

test("a newcomer's hello is answered once, so it sees who is here without waiting", async () => {
  const h = await household();
  const sam = h.open("sam"), alex = h.open("alex");
  await Promise.all([sam.load(), alex.load()]);
  alex.setActive(true);
  await settleTasks();
  h.frames.splice(0);
  sam.setActive(true);
  await settleTasks();
  await h.deliver(["alex"]);
  await settleTasks();
  assert.equal(h.frames.filter((frame) => frame.from === "alex").length, 1, "Alex answers");
  await h.deliver(["sam"]);
  assert.deepEqual(sam.online(), [ALEX]);
  // A second hello right after is not answered again.
  h.frames.splice(0);
  sam.reconnected();
  await settleTasks();
  await h.deliver(["alex"]);
  await settleTasks();
  assert.equal(h.frames.filter((frame) => frame.from === "alex").length, 0);
});

test("turning the setting off stops my heartbeats and hides everyone's status, on all my devices", async () => {
  const h = await household();
  const phone = h.open("phone"), laptop = h.open("laptop"), sam = h.open("sam");
  await Promise.all([phone.load(), laptop.load(), sam.load()]);
  await phone.refresh();
  sam.setActive(true);
  phone.setActive(true);
  laptop.setActive(true);
  await settleTasks();
  await h.deliver();
  // The phone answers Sam's hello in the background; let that reply go out
  // before clearing, or it lands after the splice and counts as a second frame.
  await settleTasks();
  assert.deepEqual(phone.online(), [SAM]);
  h.frames.splice(0);
  await phone.setSettings({ online: false });
  await settleTasks();
  assert.deepEqual(phone.online(), [], "I see no one");
  assert.equal(h.frames.filter((frame) => frame.from === "phone").length, 1, "one 'away', then nothing");
  // The laptop learns from the slot and does the same.
  await laptop.refresh();
  await settleTasks();
  assert.equal(laptop.settings.online, false);
  assert.deepEqual(laptop.online(), []);
  h.frames.splice(0);
  await h.advance(ONLINE_BEAT_MS * 2);
  await settleTasks();
  assert.equal(h.frames.filter((frame) => frame.from === "phone" || frame.from === "laptop").length, 0, "no heartbeats from either");
  // Frames that arrive anyway are ignored while it is off.
  sam.reconnected();
  await settleTasks();
  await h.deliver(["phone", "laptop"]);
  assert.deepEqual(phone.online(), []);
  // On again: heartbeats resume.
  await phone.setSettings({ online: true });
  await settleTasks();
  assert.ok(h.frames.some((frame) => frame.from === "phone"));
});

test("without chat access nothing is sent or shown; stale, forged and replayed online frames show nothing", async () => {
  const h = await household();
  let access = true;
  const sam = h.open("sam"), alex = h.open("alex");
  alex.env.hasAccess = () => access;
  await Promise.all([sam.load(), alex.load()]);
  sam.setActive(true);
  await settleTasks();
  const first = h.frames[0];
  await h.deliver(["alex"]);
  assert.deepEqual(alex.online(), [SAM]);
  assert.equal(await alex.receiveOnline(first.bytes), false, "a replay shows nothing new");
  access = false;
  alex.accessChanged();
  assert.deepEqual(alex.online(), [], "no access: cleared");
  alex.setActive(true);
  await settleTasks();
  assert.equal(h.frames.filter((frame) => frame.from === "alex").length, 0, "and nothing sent");
  access = true;
  alex.accessChanged();
  await settleTasks();
  assert.equal(h.frames.filter((frame) => frame.from === "alex").length, 1, "access back: says it is here");
  // Forged: garbage and a frame from nobody.
  assert.equal(await alex.receiveOnline(new TextEncoder().encode("not json")), false);
  assert.equal(await alex.receiveOnline(new TextEncoder().encode(JSON.stringify({ deviceId: id(0x99) }))), false);
  // Stale: sealed a minute ago.
  const stale = await household();
  const old = stale.open("sam"), watcher = stale.open("alex");
  await Promise.all([old.load(), watcher.load()]);
  old.setActive(true);
  await settleTasks();
  stale.clock.timers = [];
  await stale.advance(60_000);
  await stale.deliver();
  assert.deepEqual(watcher.online(), [], "a frame sealed long ago shows nothing");
});

test("the online tracker expires devices on its own", () => {
  let now = 0;
  const tracker = new OnlineTracker({ now: () => now });
  tracker.set("d1", "m1", true);
  tracker.set("d2", "m1", true);
  now = 69_999;
  assert.deepEqual(tracker.active(), ["m1"]);
  tracker.set("d2", "m1", false);
  tracker.set("d1", "m1", true);
  now = 140_000;
  assert.deepEqual(tracker.active(), []);
  assert.equal(tracker.nextExpiry(), null);
});

test("frames that finish opening out of order never undo a newer one, and a failed beat doesn't hide a later away", async () => {
  const h = await household();
  const sam = h.open("sam"), alex = h.open("alex");
  await Promise.all([sam.load(), alex.load()]);
  sam.setActive(true);
  await settleTasks();
  sam.setActive(false);
  await settleTasks();
  const [beat, away] = h.frames.splice(0);
  // The beat's key lookup is slow, so it finishes after the away.
  let lookups = 0;
  alex.env.epochKey = async () => { lookups += 1; if (lookups === 1) await new Promise((resolve) => setTimeout(resolve, 80)); return h.key; };
  const first = alex.receiveOnline(beat.bytes);
  const second = alex.receiveOnline(away.bytes);
  await Promise.all([first, second]);
  assert.deepEqual(alex.online(), [], "away stays away");
  // Hello replies are throttled per sending device, not for everyone.
  const sam2 = h.open("phone"), laptop = h.open("laptop");
  await Promise.all([sam2.load(), laptop.load()]);
  alex.setActive(true);
  await settleTasks();
  h.frames.splice(0);
  sam2.setActive(true);
  laptop.setActive(true);
  await settleTasks();
  await h.deliver(["alex"]);
  await settleTasks();
  assert.equal(h.frames.filter((frame) => frame.from === "alex").length, 2, "each newcomer is answered");
});

test("a beat that fails while the channel is down does not stop a later away being sent", async () => {
  const h = await household();
  let up = false;
  const sam = h.open("sam", { liveUp: true });
  sam.env.sendLive = (bytes, kind) => { if (!up) return false; h.frames.push({ from: "sam", bytes, kind }); return true; };
  await sam.load();
  sam.setActive(true);
  await settleTasks();
  up = true;
  await h.advance(30_000);
  await settleTasks();
  const sent = h.frames.length;
  sam.setActive(false);
  await settleTasks();
  assert.equal(h.frames.length, sent + 1, "the away goes out");
});
