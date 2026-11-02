// Per-device limits on chat traffic (#125). Chat shares the service's
// general request limit with sync; these bound what one device may add to a
// household's chat, so a broken or abusive client can't fill the shared
// event log and blob quota in minutes. Counts are in memory: a restart
// forgets them, which only ever lets a device send a little sooner.
import { PairingError } from "./pairing-service.mjs";

/** Most chat events one device may send in a minute (a long offline outbox
 * goes out over a few minutes; people type slower than this). */
export const CHAT_EVENTS_PER_MINUTE = 120;
/** Most blobs one device may upload in a minute (a message of ten photos is
 * about thirty: text, manifest, parts). */
export const CHAT_UPLOADS_PER_MINUTE = 120;
/** Most ciphertext one device may upload in ten minutes. */
export const CHAT_UPLOAD_BYTES_PER_TEN_MINUTES = 256 * 1024 * 1024;

const MAX_DEVICES = 4096;

/** A sliding window of weighted spends per device. */
export class DeviceWindow {
  constructor({ limit, windowMs, now = () => Date.now(), maxDevices = MAX_DEVICES }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxDevices = maxDevices;
    /** deviceId → [[time, weight]] */
    this.spends = new Map();
  }

  /** Whether `spend(deviceId, weight)` would succeed, without spending. */
  allows(deviceId, weight = 1) {
    const cutoff = this.now() - this.windowMs;
    let used = 0;
    for (const [time, amount] of this.spends.get(deviceId) ?? []) if (time > cutoff) used += amount;
    return used + weight <= this.limit;
  }

  /** Spends `weight` for `deviceId`, or returns false without spending when
   * the window is full. */
  spend(deviceId, weight = 1) {
    const now = this.now();
    const cutoff = now - this.windowMs;
    for (const [key, entries] of this.spends) {
      if (entries.at(-1)[0] <= cutoff) this.spends.delete(key);
    }
    const recent = (this.spends.get(deviceId) ?? []).filter(([time]) => time > cutoff);
    const used = recent.reduce((sum, [, amount]) => sum + amount, 0);
    if (used + weight > this.limit) {
      if (recent.length) this.spends.set(deviceId, recent);
      return false;
    }
    // Past the cap on devices, the oldest is forgotten rather than refusing a newcomer.
    if (!this.spends.has(deviceId) && this.spends.size >= this.maxDevices) this.spends.delete(this.spends.keys().next().value);
    recent.push([now, weight]);
    this.spends.set(deviceId, recent);
    return true;
  }
}

export const chatRateLimited = (what) =>
  new PairingError("chat_rate_limited", `Too ${what} too fast. Chat will try again in a moment.`, 429);
