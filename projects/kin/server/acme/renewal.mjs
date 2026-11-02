// Renewal, hot swap, status and the daily CT check (#727, ADR 0025 §5, §11).
//
// One CertificateManager per home server name. It:
//
//   - loads the stored certificate and puts it on the TLS server;
//   - follows ACME Renewal Information (ARI, RFC 9773, #751) when the CA
//     offers it: polls the suggested window, renews at a uniformly random
//     time in it, and names the old certificate in `replaces`;
//   - otherwise, or when ARI fails, renews once two thirds of the
//     certificate's lifetime has passed (or at once when there is none, it
//     has expired, it doesn't match its key or doesn't cover the name), with
//     a new certificate key each time;
//   - on failure retries after 1 hour, doubling to at most 24 hours, or later
//     if the CA's Retry-After says so (rate limits);
//   - swaps the new certificate in with `setSecureContext` (no restart);
//   - runs the CT check once a day and keeps the result;
//   - reports all of it as a plain object for the control panel (#718).
//
// Time, timers and randomness are injected so tests drive the schedule
// without waiting (docs/HOME-CERTIFICATES.md).
//
// The ARI rule, with T = two thirds of the lifetime and [S, E) the window:
//   - E ≤ now (the window has passed): renew now;
//   - S ≥ T (the whole window lies after T): renew at T. Never later than T
//     is the bound that keeps a wrong or hostile answer from pushing renewal
//     towards expiry, so it wins over the window here;
//   - otherwise a uniformly random time in [S, min(E, T)): never before S,
//     never after T. A time already past means now (§4.2).
// The time is kept while later polls return the same window and chosen again
// when the window moves (an incident can pull it earlier). No ARI, no
// identifier (no AKI) or a failed first poll: T. A failed later poll keeps
// the last window's time. A failed renewal backs off exactly as before: the
// backoff time, not the window, says when to try again.
import { X509Certificate, createPublicKey } from "node:crypto";
import { AcmeClient, obtainCertificate } from "./client.mjs";
import { checkTransparency, normalizeSerial } from "./ct-check.mjs";
import { generateP256Key, spkiSha256 } from "./keys.mjs";
import { applyCertificate } from "./tls-hook.mjs";
import { assertDnsName, certificateIdentifier } from "./x509.mjs";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const RENEW_FRACTION = 2 / 3;
export const BACKOFF_FIRST_MS = HOUR;
export const BACKOFF_MAX_MS = 24 * HOUR;
export const RETRY_AFTER_MAX_MS = 7 * DAY;
export const EXPIRY_WARNING_MS = 14 * DAY;
export const TRANSPARENCY_INTERVAL_MS = DAY;
// ARI polls: the CA's Retry-After, clamped to 1 h – 24 h; 6 h when it gives
// none. A CA without `renewalInfo` is asked again (directory only) daily.
export const ARI_POLL_MIN_MS = HOUR;
export const ARI_POLL_MAX_MS = DAY;
export const ARI_POLL_DEFAULT_MS = 6 * HOUR;
export const ARI_UNSUPPORTED_RECHECK_MS = DAY;
// setTimeout holds at most 2^31 - 1 ms; wake at least daily and re-plan.
const MAX_TIMER_MS = DAY;

/** When to renew a certificate valid from `notBefore` to `notAfter`. */
export const renewalTime = (notBefore, notAfter) => notBefore + Math.floor((notAfter - notBefore) * RENEW_FRACTION);

/** The wait before the next ARI poll for a Retry-After of `retryAfterMs`
 * (undefined when there was none). */
export function ariPollDelay(retryAfterMs) {
  if (!Number.isFinite(retryAfterMs)) return ARI_POLL_DEFAULT_MS;
  return Math.min(Math.max(retryAfterMs, ARI_POLL_MIN_MS), ARI_POLL_MAX_MS);
}

/**
 * When to renew a certificate valid from `notBefore` to `notAfter` given the
 * CA's suggested window [`start`, `end`) (ms since epoch); see the rule at
 * the top of this file. `random` returns [0, 1).
 */
export function chooseRenewalTime({ start, end }, { notBefore, notAfter }, now, random = Math.random) {
  const latest = renewalTime(notBefore, notAfter);
  if (end <= now) return now;
  if (start >= latest) return latest;
  const upper = Math.min(end, latest);
  return start + Math.floor(random() * (upper - start));
}

/** The wait after the `failures`-th failure in a row (1-based): 1 h, 2 h, 4 h
 * … 24 h, or the CA's Retry-After when that is longer (at most 7 days). */
export function backoffDelay(failures, retryAfterMs) {
  const backoff = Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
  return Number.isFinite(retryAfterMs) ? Math.max(backoff, Math.min(retryAfterMs, RETRY_AFTER_MAX_MS)) : backoff;
}

/** The CAA records that bind `name` to this ACME account (RFC 8657), as the
 * relay serves them for a free name and as a household publishes them for its
 * own domain. */
export function caaRecords(name, accountUrl, issuer = "letsencrypt.org") {
  return [
    `${name}. CAA 0 issue "${issuer}; accounturi=${accountUrl}; validationmethods=tls-alpn-01"`,
    `${name}. CAA 0 issuewild ";"`,
  ];
}

/** Facts about a PEM chain's leaf, or null when it can't be read. */
export function describeChain(chainPem) {
  try {
    const leaf = new X509Certificate(chainPem);
    return {
      leaf,
      notBefore: Date.parse(leaf.validFrom),
      notAfter: Date.parse(leaf.validTo),
      serial: normalizeSerial(leaf.serialNumber),
      issuer: leaf.issuer.split("\n").find((line) => line.startsWith("CN="))?.slice(3) ?? leaf.issuer,
    };
  } catch {
    return null;
  }
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export class CertificateManager {
  #timer = null;
  #ctTimer = null;
  #running = null;
  #current = null; // { key, chainPem, notBefore, notAfter, serial, issuer }
  #failures = 0;
  #nextAttemptAt = null;
  #lastError = null;
  #lastRenewedAt = null;
  #renewing = false;
  #accountUrl = null;
  #transparency = { state: "not-checked", checkedAt: null, unexpected: [], error: null };
  // ARI for #current. state: "unknown" (not asked yet), "ok", "failed",
  // "unsupported" (the CA has no renewalInfo), "no-identifier" (no AKI) or
  // "none" (no certificate). `renewAt` is the chosen time or null (use T).
  #ari = CertificateManager.#noAri("none");
  #ariRunning = null;

  /**
   * @param {object} options
   * @param {string} options.name the home server's DNS name
   * @param {import("./keys.mjs").CertificateStore} options.store
   * @param {string} options.directoryUrl ACME directory (Let's Encrypt production by default in home mode)
   * @param {Function} options.transport outbound HTTP (transport.mjs)
   * @param {import("./tls-alpn.mjs").ChallengeResponder} options.responder
   * @param {import("node:tls").Server} [options.server] the TLS server to hot-swap
   * @param {boolean} [options.termsOfServiceAgreed] the admin agreed in setup
   * @param {string[]} [options.contact] e.g. ["mailto:…"]; optional
   * @param {{ now(): number, setTimeout: Function, clearTimeout: Function }} [options.clock]
   * @param {(ms: number) => Promise<void>} [options.sleep] between ACME polls
   * @param {() => number} [options.random] [0, 1), for the time in the ARI window
   * @param {Function} [options.ctTransport] for the CT search (defaults to `transport`)
   * @param {string} [options.ctBaseUrl]
   * @param {(event: { type: string }) => void} [options.onEvent] renewed, failed, expiring, transparency-alert
   * @param {(account: { accountUrl: string, caa: string[] }) => Promise<void>} [options.beforeOrder]
   *   runs after the account exists and before each order: where the tunnel
   *   (#733) publishes CAA through the relay. A failure stops the order.
   */
  constructor({ name, store, directoryUrl, transport, responder, server = null, termsOfServiceAgreed = false, contact, clock = { now: Date.now, setTimeout, clearTimeout }, sleep, random = Math.random, ctTransport, ctBaseUrl, onEvent = () => {}, beforeOrder = async () => {} }) {
    this.name = assertDnsName(name);
    Object.assign(this, { store, directoryUrl, transport, responder, server, termsOfServiceAgreed, contact, clock, sleep, random, ctTransport: ctTransport ?? transport, ctBaseUrl, onEvent, beforeOrder });
  }

  static #noAri(state, certificateId = null, nextCheckAt = null) {
    return { state, certificateId, window: null, renewAt: null, explanationURL: null, checkedAt: null, nextCheckAt, error: null };
  }

  /** Fresh ARI state for #current. `supported` is what the directory just
   * said (true, false) or undefined when it hasn't been read. */
  #resetAri(supported) {
    if (!this.#current) { this.#ari = CertificateManager.#noAri("none"); return; }
    let certificateId = null;
    try { certificateId = certificateIdentifier(this.#current.leaf.raw); } catch { /* unreadable AKI: same as none */ }
    if (!certificateId) this.#ari = CertificateManager.#noAri("no-identifier");
    else if (supported === false) this.#ari = CertificateManager.#noAri("unsupported", certificateId, this.clock.now() + ARI_UNSUPPORTED_RECHECK_MS);
    else this.#ari = CertificateManager.#noAri("unknown", certificateId, this.clock.now());
  }

  #client(accountKey) {
    return new AcmeClient({ directoryUrl: this.directoryUrl, accountKey, transport: this.transport, accountUrl: this.#accountUrl, ...(this.sleep ? { sleep: this.sleep } : {}), now: () => this.clock.now() });
  }

  /** Load what is stored, put it on the server, and plan the next renewal and
   * CT check. Doesn't wait for a renewal. */
  async start() {
    await this.#load();
    this.#plan();
    this.#planTransparency(this.#current ? TRANSPARENCY_INTERVAL_MS : HOUR);
    return this.status();
  }

  stop() {
    if (this.#timer) this.clock.clearTimeout(this.#timer);
    if (this.#ctTimer) this.clock.clearTimeout(this.#ctTimer);
    this.#timer = this.#ctTimer = null;
  }

  async #load() {
    const stored = await this.store.certificate();
    const account = await this.store.account();
    if (account?.directoryUrl === this.directoryUrl) this.#accountUrl = account.accountUrl;
    if (!stored) return;
    const facts = describeChain(stored.chainPem);
    if (!facts || !facts.leaf.publicKey.equals(createPublicKey(stored.key)) || !facts.leaf.checkHost(this.name)) return;
    this.#current = { key: stored.key, chainPem: stored.chainPem, ...facts };
    this.#resetAri();
    if (this.server) applyCertificate(this.server, stored);
  }

  /** When the current certificate should be renewed if nothing fails: the
   * ARI choice, else two thirds of its lifetime. */
  #plannedRenewal() {
    return this.#ari.renewAt ?? renewalTime(this.#current.notBefore, this.#current.notAfter);
  }

  #ariDue() {
    return this.#current && this.#ari.nextCheckAt !== null && this.clock.now() >= this.#ari.nextCheckAt;
  }

  /** When the next renewal attempt is due (ms since epoch). */
  dueAt() {
    if (this.#nextAttemptAt !== null) return this.#nextAttemptAt;
    if (!this.#current || this.clock.now() >= this.#current.notAfter) return this.clock.now();
    return this.#plannedRenewal();
  }

  #plan() {
    if (this.#timer) this.clock.clearTimeout(this.#timer);
    const ariAt = this.#current && this.#ari.nextCheckAt !== null ? this.#ari.nextCheckAt : Infinity;
    const delay = Math.min(Math.max(0, Math.min(this.dueAt(), ariAt) - this.clock.now()), MAX_TIMER_MS);
    this.#timer = this.clock.setTimeout(() => {
      this.#timer = null;
      // Failures are recorded in status, and both re-plan when they finish.
      if (this.clock.now() >= this.dueAt()) this.renew().catch(() => {});
      else if (this.#ariDue()) this.refreshRenewalInfo().catch(() => {});
      else this.#plan();
    }, delay);
    this.#timer?.unref?.();
    if (this.#current && this.#current.notAfter - this.clock.now() < EXPIRY_WARNING_MS) this.onEvent({ type: "expiring", notAfter: iso(this.#current.notAfter) });
  }

  #planTransparency(delay) {
    if (this.#ctTimer) this.clock.clearTimeout(this.#ctTimer);
    this.#ctTimer = this.clock.setTimeout(() => {
      this.#ctTimer = null;
      this.checkTransparency().catch(() => {}).finally(() => this.#planTransparency(TRANSPARENCY_INTERVAL_MS));
    }, delay);
    this.#ctTimer?.unref?.();
  }

  /** Get a new certificate now (one attempt; concurrent calls share it). */
  renew() {
    this.#running ??= this.#renewOnce().finally(() => { this.#running = null; });
    return this.#running;
  }

  async #renewOnce() {
    this.#renewing = true;
    try {
      const accountKey = await this.store.accountKey();
      const client = this.#client(accountKey);
      await client.ensureAccount({ termsOfServiceAgreed: this.termsOfServiceAgreed, contact: this.contact });
      if (client.accountUrl !== this.#accountUrl) {
        this.#accountUrl = client.accountUrl;
        await this.store.saveAccount({ directoryUrl: this.directoryUrl, accountUrl: client.accountUrl });
      }
      // ADR 0025 §5: CAA must name this account before the first order
      // (relay CONTROL op 3 SET_CAA for a free name, #733).
      await this.beforeOrder({ accountUrl: this.#accountUrl, caa: caaRecords(this.name, this.#accountUrl) });
      const certificateKey = generateP256Key();
      // RFC 9773 §5: name the certificate this one succeeds (the client
      // leaves it out for a CA without renewalInfo).
      const replaces = this.#current ? this.#ari.certificateId ?? undefined : undefined;
      const { chainPem } = await obtainCertificate(client, { names: [this.name], certificateKey, responder: this.responder, replaces });
      const facts = describeChain(chainPem);
      await this.store.saveCertificate({ key: certificateKey, chainPem });
      await this.store.remember({ spkiSha256: spkiSha256(certificateKey), serial: facts.serial, notAfter: iso(facts.notAfter) });
      this.#current = { key: certificateKey, chainPem, ...facts };
      this.#resetAri(Boolean(client.cachedDirectory?.renewalInfo));
      if (this.server) applyCertificate(this.server, { key: certificateKey, chainPem });
      this.#failures = 0;
      this.#nextAttemptAt = null;
      this.#lastError = null;
      this.#lastRenewedAt = this.clock.now();
      this.onEvent({ type: "renewed", notAfter: iso(facts.notAfter) });
    } catch (error) {
      this.#failures += 1;
      this.#nextAttemptAt = this.clock.now() + backoffDelay(this.#failures, error?.retryAfterMs);
      // acme-* from the CA or the client; tunnel-* from beforeOrder (the
      // home server's relay tunnel, #733: not connected, or CAA refused).
      this.#lastError = { code: typeof error?.code === "string" && /^(?:acme|tunnel)-/.test(error.code) ? error.code : "acme-error", detail: error?.detail ?? null, at: iso(this.clock.now()) };
      this.onEvent({ type: "failed", code: this.#lastError.code, nextAttemptAt: iso(this.#nextAttemptAt) });
      throw error;
    } finally {
      this.#renewing = false;
      this.#plan();
    }
    return this.status();
  }

  /**
   * Ask the CA for the current certificate's renewal information now and
   * choose the renewal time (one request; concurrent calls share it). A
   * failure is recorded in `status().renewalInfo.error`, the next poll is
   * planned, and the error is rethrown.
   */
  refreshRenewalInfo() {
    this.#ariRunning ??= this.#refreshOnce().finally(() => { this.#ariRunning = null; });
    return this.#ariRunning;
  }

  async #refreshOnce() {
    const current = this.#current;
    const certificateId = this.#ari.certificateId;
    if (!current || !certificateId) return this.status().renewalInfo;
    try {
      const info = await this.#client(await this.store.accountKey()).renewalInfo(certificateId);
      if (this.#current !== current) return this.status().renewalInfo; // renewed meanwhile
      const now = this.clock.now();
      if (info === null) {
        this.#ari = CertificateManager.#noAri("unsupported", certificateId, now + ARI_UNSUPPORTED_RECHECK_MS);
        this.#ari.checkedAt = now;
      } else {
        const previous = this.#ari;
        const sameWindow = previous.window?.start === info.start && previous.window?.end === info.end && previous.renewAt !== null;
        this.#ari = {
          state: "ok", certificateId,
          window: { start: info.start, end: info.end },
          renewAt: sameWindow ? previous.renewAt : chooseRenewalTime(info, current, now, this.random),
          explanationURL: info.explanationURL, checkedAt: now, nextCheckAt: now + ariPollDelay(info.retryAfterMs), error: null,
        };
      }
    } catch (error) {
      if (this.#current !== current) throw error;
      const now = this.clock.now();
      // The last good window (if any) still stands; without one, T does.
      this.#ari = {
        ...this.#ari, state: "failed",
        nextCheckAt: now + ariPollDelay(error?.retryAfterMs),
        error: { code: typeof error?.code === "string" && error.code.startsWith("acme-") ? error.code : "acme-error", detail: error?.detail ?? null, at: iso(now) },
      };
      throw error;
    } finally {
      // Not while a renewal runs: its own finally re-plans.
      if (!this.#renewing) this.#plan();
    }
    return this.status().renewalInfo;
  }

  /** Run the CT check now and keep the result. */
  async checkTransparency() {
    const history = await this.store.history();
    const serials = history.map((entry) => entry.serial);
    const spkiHashes = history.map((entry) => entry.spkiSha256);
    if (this.#current) { serials.push(this.#current.serial); spkiHashes.push(spkiSha256(this.#current.key)); }
    try {
      const { checked, unexpected } = await checkTransparency({ name: this.name, transport: this.ctTransport, known: { serials, spkiHashes }, ...(this.ctBaseUrl ? { baseUrl: this.ctBaseUrl } : {}) });
      this.#transparency = { state: unexpected.length ? "alert" : "ok", checkedAt: iso(this.clock.now()), checked, unexpected, error: null };
      if (unexpected.length) this.onEvent({ type: "transparency-alert", count: unexpected.length });
    } catch (error) {
      // An unreachable search service isn't an alert; the last result stays.
      this.#transparency = { ...this.#transparency, error: { code: error?.code ?? "ct-unavailable", at: iso(this.clock.now()) } };
      throw error;
    }
    return this.#transparency;
  }

  /** What the control panel shows. Dates are ISO strings; nothing secret. */
  status() {
    const now = this.clock.now();
    const current = this.#current;
    let state = "none";
    if (current) state = now >= current.notAfter ? "expired" : "valid";
    if (this.#renewing) state = "renewing";
    else if (this.#failures > 0) state = current && now < current.notAfter ? "valid-retrying" : "failed";
    const msLeft = current ? current.notAfter - now : null;
    return {
      name: this.name,
      state,
      certificate: current ? {
        notBefore: iso(current.notBefore),
        notAfter: iso(current.notAfter),
        serial: current.serial,
        issuer: current.issuer,
        daysLeft: Math.max(0, Math.floor(msLeft / DAY)),
      } : null,
      expiringSoon: current ? msLeft < EXPIRY_WARNING_MS : false,
      renewAt: current ? iso(this.#plannedRenewal()) : null,
      nextAttemptAt: iso(this.#nextAttemptAt ?? (current ? null : now)),
      failures: this.#failures,
      lastError: this.#lastError,
      lastRenewedAt: iso(this.#lastRenewedAt),
      accountUrl: this.#accountUrl,
      caa: this.#accountUrl ? caaRecords(this.name, this.#accountUrl) : null,
      transparency: { ...this.#transparency, unexpected: [...this.#transparency.unexpected] },
      renewalInfo: {
        state: this.#ari.state,
        certificateId: this.#ari.certificateId,
        suggestedWindow: this.#ari.window ? { start: iso(this.#ari.window.start), end: iso(this.#ari.window.end) } : null,
        explanationURL: this.#ari.explanationURL,
        checkedAt: iso(this.#ari.checkedAt),
        nextCheckAt: iso(this.#ari.nextCheckAt),
        error: this.#ari.error,
      },
    };
  }
}
