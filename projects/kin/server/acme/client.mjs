// An ACME (RFC 8555) client without dependencies (#724, ADR 0025 §5).
//
// Flow, each step one signed POST unless noted:
//
//   GET directory ─▶ HEAD newNonce ─▶ newAccount (JWS with `jwk`)
//     ─▶ newOrder (JWS with `kid` from now on) ─▶ POST-as-GET each authorization
//     ─▶ install the TLS-ALPN-01 answer ─▶ POST {} to the challenge
//     ─▶ poll the authorization (Retry-After) ─▶ finalize with the CSR
//     ─▶ poll the order ─▶ POST-as-GET the certificate (PEM chain)
//
// Requests are JWS in the flattened JSON serialization (RFC 7515 §7.2.2):
//   { "protected": b64url(header), "payload": b64url(json) or "", "signature": b64url(r‖s) }
// with header { alg: "ES256", nonce, url, jwk | kid } (RFC 8555 §6.2). An
// empty payload is a POST-as-GET (§6.3). Every response's Replay-Nonce is kept
// for the next request; a `badNonce` error is retried with the nonce that came
// with it (§6.5), up to three times.
//
// ACME Renewal Information (RFC 9773, #751): when the directory names
// `renewalInfo`, `renewalInfo(id)` is an unauthenticated GET of
// `<renewalInfo>/<certificate identifier>` (§4.1; x509.mjs computes the
// identifier) answering { suggestedWindow: { start, end }, explanationURL? }
// with Retry-After for the next poll, and a newOrder may carry `replaces`
// (§5). A CA without `renewalInfo` never sees `replaces`.
//
// The HTTP transport is injected (transport.mjs), so tests run against an
// in-process server and nothing here opens a socket by itself.
import { X509Certificate, createPublicKey, sign } from "node:crypto";
import { b64url, jwkThumbprint, publicJwk } from "./keys.mjs";
import { buildCsr } from "./csr.mjs";

export const LETS_ENCRYPT_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
export const LETS_ENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

const ERROR_PREFIX = "urn:ietf:params:acme:error:";

/** ACME problem types (RFC 8555 §6.7) to the plain codes Kin shows. */
const ERROR_CODES = Object.freeze({
  accountDoesNotExist: "acme-no-account",
  alreadyReplaced: "acme-already-replaced",
  alreadyRevoked: "acme-already-revoked",
  badCSR: "acme-bad-csr",
  badNonce: "acme-bad-nonce",
  badPublicKey: "acme-bad-key",
  badRevocationReason: "acme-bad-request",
  badSignatureAlgorithm: "acme-bad-key",
  caa: "acme-caa",
  compound: "acme-compound",
  connection: "acme-connection",
  dns: "acme-dns",
  externalAccountRequired: "acme-account-binding-required",
  incorrectResponse: "acme-incorrect-response",
  invalidContact: "acme-bad-contact",
  malformed: "acme-malformed",
  orderNotReady: "acme-order-not-ready",
  rateLimited: "acme-rate-limited",
  rejectedIdentifier: "acme-rejected-name",
  serverInternal: "acme-server-error",
  tls: "acme-tls",
  unauthorized: "acme-unauthorized",
  unsupportedContact: "acme-bad-contact",
  unsupportedIdentifier: "acme-rejected-name",
  userActionRequired: "acme-terms-changed",
});

/** Every code an AcmeError can carry. The protocol ones come from the table
 * above; the rest are the client's own. */
export const ACME_ERROR_CODES = Object.freeze([...new Set([
  ...Object.values(ERROR_CODES),
  "acme-error", "acme-network", "acme-timeout", "acme-bad-response", "acme-no-challenge",
  "acme-authorization-invalid", "acme-order-invalid", "acme-terms-not-agreed", "acme-insecure-url",
  "acme-key-mismatch",
])]);

/** A failure with a plain `code` (one of ACME_ERROR_CODES). `detail` is the
 * server's text, cut to 300 characters: useful in the control panel's
 * details, never shown as the headline. */
export class AcmeError extends Error {
  constructor(code, message, { status, type, detail, retryAfterMs, subproblems } = {}) {
    super(message);
    this.name = "AcmeError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (type) this.type = type;
    if (detail) this.detail = String(detail).slice(0, 300);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (subproblems) this.subproblems = subproblems;
  }
}

/** An AcmeError from an RFC 7807 problem document. */
export function problemToError(problem, status, retryAfterMs) {
  const type = typeof problem?.type === "string" ? problem.type : "";
  const short = type.startsWith(ERROR_PREFIX) ? type.slice(ERROR_PREFIX.length) : "";
  let code = ERROR_CODES[short] ?? "acme-error";
  const subproblems = Array.isArray(problem?.subproblems)
    ? problem.subproblems.slice(0, 10).map((sub) => problemToError(sub)).map(({ code: subCode, detail }) => ({ code: subCode, detail }))
    : undefined;
  // A compound problem (§6.7.1) is as useful as its first subproblem.
  if (code === "acme-compound" && subproblems?.length) code = subproblems[0].code;
  return new AcmeError(code, `ACME ${short || "error"}`, { status, type, detail: problem?.detail, retryAfterMs, subproblems });
}

/** Milliseconds from a Retry-After header (delta-seconds or an HTTP date),
 * or undefined. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// RFC 3339 date-time (§5.6), as ARI's suggestedWindow carries it.
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const ARI_IDENTIFIER = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** An https URL of at most 2000 characters, or null: the only kind of
 * `explanationURL` the control panel will offer as a link. */
function httpsUrlOrNull(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try { return new URL(value).protocol === "https:" ? value : null; } catch { return null; }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

export class AcmeClient {
  /**
   * @param {object} options
   * @param {string} options.directoryUrl
   * @param {import("node:crypto").KeyObject} options.accountKey P-256 private key
   * @param {Function} options.transport see transport.mjs
   * @param {string} [options.accountUrl] the account's URL (`kid`) when known
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {() => number} [options.now]
   * @param {number} [options.pollLimit] polls per authorization or order
   * @param {number} [options.maxPollDelayMs] the longest wait between polls
   */
  constructor({ directoryUrl, accountKey, transport, accountUrl = null, sleep = defaultSleep, now = Date.now, pollLimit = 30, maxPollDelayMs = 60_000 }) {
    if (!directoryUrl || !accountKey || typeof transport !== "function") throw new TypeError("directoryUrl, accountKey and transport are required");
    this.directoryUrl = directoryUrl;
    this.accountKey = accountKey;
    this.transport = transport;
    this.accountUrl = accountUrl;
    this.sleep = sleep;
    this.now = now;
    this.pollLimit = pollLimit;
    this.maxPollDelayMs = maxPollDelayMs;
    this.thumbprint = jwkThumbprint(accountKey);
    this.jwk = publicJwk(accountKey);
    this.nonce = null;
    this.cachedDirectory = null;
  }

  /** `token.thumbprint` (RFC 8555 §8.1). */
  keyAuthorization(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(token)) throw new AcmeError("acme-bad-response", "challenge token is not base64url");
    return `${token}.${this.thumbprint}`;
  }

  async #send(url, init) {
    try {
      return await this.transport(url, init);
    } catch (error) {
      if (error instanceof AcmeError) throw error;
      throw new AcmeError(error?.code === "acme-timeout" ? "acme-timeout" : error?.code === "acme-insecure-url" ? "acme-insecure-url" : "acme-network", "could not reach the ACME server", { detail: error?.message });
    }
  }

  #keepNonce(response) {
    const nonce = response.headers.get("replay-nonce");
    if (nonce && /^[A-Za-z0-9_-]+$/.test(nonce)) this.nonce = nonce;
  }

  async directory() {
    if (this.cachedDirectory) return this.cachedDirectory;
    const response = await this.#send(this.directoryUrl, { method: "GET" });
    const body = await readJson(response);
    if (response.status !== 200 || !body?.newNonce || !body?.newAccount || !body?.newOrder) {
      throw new AcmeError("acme-bad-response", "not an ACME directory", { status: response.status });
    }
    this.cachedDirectory = body;
    return body;
  }

  async #freshNonce() {
    if (this.nonce) { const nonce = this.nonce; this.nonce = null; return nonce; }
    const { newNonce } = await this.directory();
    const response = await this.#send(newNonce, { method: "HEAD" });
    this.#keepNonce(response);
    if (!this.nonce) throw new AcmeError("acme-bad-response", "the server gave no nonce", { status: response.status });
    const nonce = this.nonce; this.nonce = null;
    return nonce;
  }

  /** The flattened JWS for `payload` (undefined for POST-as-GET). */
  signRequest(url, payload, nonce, { useJwk = false } = {}) {
    const header = { alg: "ES256", nonce, url, ...(useJwk ? { jwk: this.jwk } : { kid: this.accountUrl }) };
    const protectedPart = b64url(JSON.stringify(header));
    const payloadPart = payload === undefined ? "" : b64url(JSON.stringify(payload));
    const signature = sign("sha256", Buffer.from(`${protectedPart}.${payloadPart}`, "ascii"), { key: this.accountKey, dsaEncoding: "ieee-p1363" });
    return { protected: protectedPart, payload: payloadPart, signature: b64url(signature) };
  }

  /** A signed POST; returns { status, headers, body (parsed JSON or text) }. */
  async post(url, payload, { useJwk = false, accept } = {}) {
    if (!useJwk && !this.accountUrl) throw new AcmeError("acme-no-account", "no ACME account yet");
    for (let attempt = 0; ; attempt += 1) {
      const nonce = await this.#freshNonce();
      const response = await this.#send(url, {
        method: "POST",
        headers: { "content-type": "application/jose+json", ...(accept ? { accept } : {}) },
        body: JSON.stringify(this.signRequest(url, payload, nonce, { useJwk })),
      });
      this.#keepNonce(response);
      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();
      if (response.status >= 400) {
        let problem = null;
        try { problem = JSON.parse(text); } catch { /* not a problem document */ }
        const error = problemToError(problem, response.status, parseRetryAfter(response.headers.get("retry-after"), this.now()));
        if (error.code === "acme-bad-nonce" && attempt < 3) continue;
        throw error;
      }
      let body = text;
      if (/json/.test(contentType)) {
        try { body = JSON.parse(text); } catch { throw new AcmeError("acme-bad-response", "unparseable JSON from the ACME server", { status: response.status }); }
      }
      return { status: response.status, headers: response.headers, body };
    }
  }

  postAsGet(url, options) { return this.post(url, undefined, options); }

  /** Create the account, or find it if this key already has one (§7.3: the
   * server answers 200 with the existing account's URL). */
  async ensureAccount({ termsOfServiceAgreed = false, contact } = {}) {
    if (this.accountUrl) return this.accountUrl;
    if (termsOfServiceAgreed !== true) throw new AcmeError("acme-terms-not-agreed", "the CA's terms of service must be agreed first");
    const { newAccount } = await this.directory();
    const response = await this.post(newAccount, { termsOfServiceAgreed: true, ...(contact?.length ? { contact } : {}) }, { useJwk: true });
    const location = response.headers.get("location");
    if (!location) throw new AcmeError("acme-bad-response", "account created without a Location");
    if (response.body?.status && response.body.status !== "valid") throw new AcmeError("acme-unauthorized", `account is ${response.body.status}`);
    this.accountUrl = location;
    return location;
  }

  /**
   * The CA's renewal information for the certificate `certificateId`
   * (RFC 9773 §4.2), or null when the CA has no `renewalInfo`.
   *
   * @returns {Promise<{ start: number, end: number, explanationURL: string | null, retryAfterMs: number | undefined } | null>}
   *   `start`/`end` in ms since epoch; `explanationURL` only when it is https.
   *   An error answer, or a window that isn't two RFC 3339 times with `end`
   *   after `start` (§4.2 calls that invalid), throws an AcmeError carrying
   *   the response's Retry-After.
   */
  async renewalInfo(certificateId) {
    if (typeof certificateId !== "string" || !ARI_IDENTIFIER.test(certificateId)) throw new TypeError("not an ARI certificate identifier");
    const { renewalInfo } = await this.directory();
    if (typeof renewalInfo !== "string" || !renewalInfo) return null;
    const response = await this.#send(`${renewalInfo.replace(/\/+$/, "")}/${certificateId}`, { method: "GET" });
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.now());
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* checked below */ }
    if (response.status !== 200) throw problemToError(body, response.status, retryAfterMs);
    const window = body?.suggestedWindow;
    const start = typeof window?.start === "string" && RFC3339.test(window.start) ? Date.parse(window.start) : NaN;
    const end = typeof window?.end === "string" && RFC3339.test(window.end) ? Date.parse(window.end) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new AcmeError("acme-bad-response", "invalid renewal information", { status: response.status, retryAfterMs });
    }
    return { start, end, explanationURL: httpsUrlOrNull(body.explanationURL), retryAfterMs };
  }

  /** A new order for `names`. `replaces` (an ARI certificate identifier) is
   * sent only to a CA whose directory has `renewalInfo`. */
  async newOrder(names, { replaces } = {}) {
    const { newOrder, renewalInfo } = await this.directory();
    const response = await this.post(newOrder, {
      identifiers: names.map((value) => ({ type: "dns", value })),
      ...(replaces && renewalInfo ? { replaces } : {}),
    });
    const url = response.headers.get("location");
    if (!url || !Array.isArray(response.body?.authorizations) || !response.body?.finalize) throw new AcmeError("acme-bad-response", "malformed order");
    return { url, ...response.body };
  }

  async #poll(url, { done, failed, failure }) {
    let lastRetryAfter;
    for (let poll = 0; poll < this.pollLimit; poll += 1) {
      const response = await this.postAsGet(url);
      const body = response.body;
      if (done(body)) return body;
      if (failed(body)) throw failure(body);
      lastRetryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now());
      await this.sleep(Math.min(Math.max(lastRetryAfter ?? 2000, 1000), this.maxPollDelayMs));
    }
    throw new AcmeError("acme-timeout", "the ACME server took too long", { retryAfterMs: lastRetryAfter });
  }

  pollAuthorization(url) {
    return this.#poll(url, {
      done: (body) => body?.status === "valid",
      failed: (body) => !["pending", "valid"].includes(body?.status),
      failure: (body) => {
        const challenge = body?.challenges?.find((item) => item?.error);
        return challenge ? problemToError(challenge.error) : new AcmeError("acme-authorization-invalid", `authorization is ${body?.status}`);
      },
    });
  }

  pollOrder(url, wanted = "valid") {
    return this.#poll(url, {
      done: (body) => body?.status === wanted || body?.status === "valid",
      failed: (body) => body?.status === "invalid" || (wanted === "valid" && !["ready", "processing", "valid"].includes(body?.status)),
      failure: (body) => body?.error ? problemToError(body.error) : new AcmeError("acme-order-invalid", `order is ${body?.status}`),
    });
  }

  async finalize(order, csrDer) {
    const response = await this.post(order.finalize, { csr: b64url(csrDer) });
    if (response.body?.status === "valid") return response.body;
    return this.pollOrder(order.url);
  }

  async downloadCertificate(url) {
    const response = await this.postAsGet(url, { accept: "application/pem-certificate-chain" });
    const pem = typeof response.body === "string" ? response.body : "";
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new AcmeError("acme-bad-response", "the certificate download is not a PEM chain");
    return pem;
  }
}

/**
 * Get a certificate for `names` with TLS-ALPN-01 (RFC 8737).
 *
 * `responder` is where the challenge answer goes: `add(name, keyAuthorization)`
 * makes the TLS server answer `acme-tls/1` for `name` with the validation
 * certificate, and `remove(name)` stops it (tls-alpn.mjs). The answer is
 * removed again whatever happens.
 *
 * `replaces` is the ARI identifier of the certificate this one succeeds
 * (RFC 9773 §5). A CA that says it was already replaced (409
 * `alreadyReplaced`, say after an issuance whose download was lost) gets the
 * order again without it: the predecessor still needs a successor.
 *
 * @returns {Promise<{ chainPem: string, orderUrl: string }>}
 */
export async function obtainCertificate(client, { names, certificateKey, responder, termsOfServiceAgreed, contact, replaces }) {
  await client.ensureAccount({ termsOfServiceAgreed, contact });
  let order;
  try {
    order = await client.newOrder(names, { replaces });
  } catch (error) {
    if (!replaces || error?.code !== "acme-already-replaced") throw error;
    order = await client.newOrder(names);
  }
  const installed = [];
  try {
    for (const authorizationUrl of order.authorizations) {
      const { body: authorization } = await client.postAsGet(authorizationUrl);
      if (authorization?.status === "valid") continue;
      if (authorization?.status !== "pending") throw new AcmeError("acme-authorization-invalid", `authorization is ${authorization?.status}`);
      const challenge = authorization.challenges?.find((item) => item?.type === "tls-alpn-01");
      if (!challenge?.url) throw new AcmeError("acme-no-challenge", "the CA offered no tls-alpn-01 challenge");
      const name = authorization.identifier?.value;
      if (!names.includes(name)) throw new AcmeError("acme-bad-response", "authorization for a name Kin did not ask for");
      responder.add(name, client.keyAuthorization(challenge.token));
      installed.push(name);
      if (challenge.status === "pending") await client.post(challenge.url, {});
      await client.pollAuthorization(authorizationUrl);
      responder.remove(name);
      installed.pop();
    }
    const ready = order.status === "ready" ? order : await client.pollOrder(order.url, "ready");
    const finished = ready.status === "valid" ? ready : await client.finalize({ ...order, ...ready, url: order.url }, buildCsr({ names, privateKey: certificateKey }));
    if (!finished.certificate) throw new AcmeError("acme-bad-response", "a valid order without a certificate URL");
    const chainPem = await client.downloadCertificate(finished.certificate);
    // The leaf must certify the key this server made (a reused order could
    // carry another key's certificate).
    const leaf = new X509Certificate(chainPem);
    if (!leaf.publicKey.equals(createPublicKey(certificateKey))) throw new AcmeError("acme-key-mismatch", "the certificate is not for this server's key");
    return { chainPem, orderUrl: order.url };
  } finally {
    for (const name of installed) responder.remove(name);
  }
}

async function readJson(response) {
  try { return JSON.parse(await response.text()); } catch { return null; }
}
