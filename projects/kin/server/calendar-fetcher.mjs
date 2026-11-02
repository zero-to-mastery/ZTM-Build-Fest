// Downloads a subscribed calendar (#667, ADR 0022 §3) with Node's own
// `https` and `dns`, guarding against the service being used to reach
// places it shouldn't (server-side request forgery):
//
// - Only `https:` on port 443, with no user name or password in the link.
// - Before every connection, including every redirect hop, the host name is
//   resolved and *every* address it gives must be public unicast
//   (web/calendar/feed-link.js isPublicAddress: no private, loopback,
//   link-local, multicast, carrier-NAT, documentation or other reserved IPv4
//   or IPv6 range, and IPv4-mapped or NAT64 IPv6 judged by their IPv4
//   address). The connection then goes to the address that was checked (the
//   socket's `lookup` returns it), so a second DNS answer can't swap in a
//   private one; TLS still verifies the certificate against the host name.
// - At most 5 redirects; a redirect to anything but https is refused.
// - At most 2 MB, refused from Content-Length when declared and counted as
//   it streams otherwise; 15 seconds for the whole download, redirects
//   included. `Accept-Encoding: identity`, and a compressed answer is
//   refused, so nothing expands after the count.
// - The body must look like iCalendar (`BEGIN:VCALENDAR`); Kin's service
//   never parses it further. Devices parse it (ADR 0022: the service only
//   relays).
//
// Test hooks: `resolve` replaces DNS (tests never use the real internet),
// and `unsafeTestHooks` ({ allowLoopback, ca, connectPort }) lets a test
// reach its own fake HTTPS server on 127.0.0.1 or ::1, connecting to its
// port in place of 443 (links themselves still must use 443), trusting its
// own certificate authority. Only code constructing a fetcher can pass it: the
// service builds its fetcher without options and reads no environment
// variable for it, so a deployment can't turn it on.
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isLocalName, isPublicAddress } from "../web/calendar/feed-link.js";

export const FEED_FETCH_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000, maxRedirects: 5 });
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const ETAG = /^(W\/)?"[\x21\x23-\x7e\x80-\xff]{0,250}"$/;

const MESSAGES = Object.freeze({
  calendar_link_not_found: "The calendar's server says this link no longer exists. It may have been reset: copy the new private link and add it again.",
  calendar_link_refused: "The calendar's server refused this link. Check that it is the private iCal link.",
  calendar_too_large: "This calendar is larger than Kin can sync (2 MB at most).",
  calendar_timeout: "The calendar's server took too long to answer. Kin will try again later.",
  calendar_address_refused: "That link leads to a private or local address, which Kin won't fetch.",
  calendar_too_many_redirects: "That link redirects too many times.",
  calendar_link_not_https: "That link redirects to an address that isn't secure (https), which Kin won't fetch.",
  calendar_link_invalid: "That link redirects somewhere Kin can't follow.",
  calendar_unreachable: "Kin couldn't reach the calendar's server. It will try again later.",
  calendar_server_error: "The calendar's server had a problem. Kin will try again later.",
  calendar_not_ical: "That link didn't return a calendar. Copy the private iCal (.ics) link from your calendar's settings.",
});

export class FeedFetchError extends Error {
  constructor(code, { status = 0 } = {}) {
    super(MESSAGES[code] ?? MESSAGES.calendar_unreachable);
    this.name = "FeedFetchError";
    this.code = MESSAGES[code] ? code : "calendar_unreachable";
    /** The calendar server's HTTP status, when it answered. */
    this.status = status;
  }
}

/** A user-facing message for a fetch error code. */
export function feedErrorMessage(code) {
  return MESSAGES[code] ?? MESSAGES.calendar_unreachable;
}

async function systemResolve(hostname) {
  return lookup(hostname, { all: true, verbatim: true });
}

const looksLikeICalendar = (body) => /^(﻿)?[\s]*BEGIN:VCALENDAR/i.test(body.subarray(0, 64).toString("utf8"));

export class CalendarFetcher {
  constructor({ resolve = systemResolve, limits = {}, unsafeTestHooks = null, userAgent = "Kin calendar sync" } = {}) {
    this.resolve = resolve;
    this.limits = { ...FEED_FETCH_LIMITS, ...limits };
    this.testHooks = unsafeTestHooks ? Object.freeze({ ...unsafeTestHooks }) : null;
    this.userAgent = userAgent;
  }

  /**
   * Downloads `url` (an https URL from normalizeFeedUrl). With `etag`, asks
   * for it only if it changed. Resolves { notModified: true, etag } or
   * { body (Buffer), etag (or null) }; rejects with a FeedFetchError.
   */
  async fetch(url, { etag = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs);
    timer.unref?.();
    try {
      return await this.follow(url, etag, controller.signal);
    } catch (error) {
      if (error instanceof FeedFetchError) throw error;
      if (controller.signal.aborted) throw new FeedFetchError("calendar_timeout");
      throw new FeedFetchError("calendar_unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  async follow(url, etag, signal) {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      const target = this.checkTarget(current);
      const address = await this.vet(target.hostname, signal);
      const response = await this.request(target, address, etag, signal);
      const status = response.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        response.resume();
        if (hop >= this.limits.maxRedirects) throw new FeedFetchError("calendar_too_many_redirects", { status });
        const location = response.headers.location;
        if (typeof location !== "string" || !location) throw new FeedFetchError("calendar_server_error", { status });
        let next;
        try { next = new URL(location, target); } catch { throw new FeedFetchError("calendar_link_invalid", { status }); }
        if (next.protocol !== "https:") throw new FeedFetchError("calendar_link_not_https", { status });
        next.hash = "";
        current = next.href;
        continue;
      }
      if (status === 304 && etag) {
        response.resume();
        return { notModified: true, etag };
      }
      if (status === 404 || status === 410) { response.resume(); throw new FeedFetchError("calendar_link_not_found", { status }); }
      if (status === 401 || status === 403) { response.resume(); throw new FeedFetchError("calendar_link_refused", { status }); }
      if (status !== 200) { response.resume(); throw new FeedFetchError("calendar_server_error", { status }); }
      const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
      if (encoding !== "identity" && encoding !== "") { response.resume(); throw new FeedFetchError("calendar_not_ical", { status }); }
      const body = await this.readBody(response, signal);
      if (!looksLikeICalendar(body)) throw new FeedFetchError("calendar_not_ical", { status });
      const tag = response.headers.etag;
      return { body, etag: typeof tag === "string" && ETAG.test(tag) ? tag : null };
    }
  }

  /** The URL of one hop, checked as a link is (feed-link.js), again. */
  checkTarget(href) {
    let target;
    try { target = new URL(href); } catch { throw new FeedFetchError("calendar_link_invalid"); }
    if (target.protocol !== "https:") throw new FeedFetchError("calendar_link_not_https");
    if (target.username || target.password) throw new FeedFetchError("calendar_link_invalid");
    if (target.port && target.port !== "443") throw new FeedFetchError("calendar_link_invalid");
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (!isIP(host) && isLocalName(host) && !this.testHooks?.allowLoopback) throw new FeedFetchError("calendar_address_refused");
    return target;
  }

  allowed(address) {
    return isPublicAddress(address) || Boolean(this.testHooks?.allowLoopback && LOOPBACK.has(address));
  }

  /** The one address to connect to: every address the host has must be
   * allowed, so a host can't mix a public answer with a private one. */
  async vet(hostname, signal) {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) {
      if (!this.allowed(host)) throw new FeedFetchError("calendar_address_refused");
      return { address: host, family: isIP(host) };
    }
    let answers;
    try { answers = await this.resolve(host); } catch { throw new FeedFetchError("calendar_unreachable"); }
    if (signal.aborted) throw new FeedFetchError("calendar_timeout");
    if (!Array.isArray(answers) || answers.length === 0) throw new FeedFetchError("calendar_unreachable");
    for (const answer of answers) {
      if (!answer || typeof answer.address !== "string" || !isIP(answer.address) || !this.allowed(answer.address))
        throw new FeedFetchError("calendar_address_refused");
    }
    return { address: answers[0].address, family: isIP(answers[0].address) };
  }

  request(target, address, etag, signal) {
    const host = target.hostname.replace(/^\[|\]$/g, "");
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        hostname: host,
        port: this.testHooks?.connectPort ?? 443,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        agent: false,
        signal,
        autoSelectFamily: false,
        // The checked address, never a fresh lookup.
        lookup: (_name, options, callback) => {
          if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        },
        ...(isIP(host) ? {} : { servername: host }),
        ...(this.testHooks?.ca ? { ca: this.testHooks.ca } : {}),
        maxHeaderSize: 16 * 1024,
        headers: {
          // The link's host, whatever port a test connects to.
          Host: target.host,
          "User-Agent": this.userAgent,
          Accept: "text/calendar, text/plain;q=0.5, */*;q=0.1",
          "Accept-Encoding": "identity",
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      }, resolve);
      request.on("error", reject);
      request.end();
    });
  }

  readBody(response, signal) {
    const limit = this.limits.maxBytes;
    const declared = response.headers["content-length"];
    if (declared !== undefined && (!/^[0-9]{1,16}$/.test(declared) || Number(declared) > limit)) {
      response.destroy();
      return Promise.reject(new FeedFetchError("calendar_too_large", { status: 200 }));
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const fail = (code) => {
        if (settled) return;
        settled = true;
        chunks.length = 0;
        reject(new FeedFetchError(code, { status: 200 }));
      };
      response.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > limit) {
          fail("calendar_too_large");
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, size));
      });
      response.on("error", () => fail(signal.aborted ? "calendar_timeout" : "calendar_unreachable"));
      response.on("aborted", () => fail(signal.aborted ? "calendar_timeout" : "calendar_unreachable"));
    });
  }
}
