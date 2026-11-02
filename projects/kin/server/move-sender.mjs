// Sending a household to a home server (ADR 0026 §1, §7, #738): the move
// package (move-package.mjs), in pieces, to the home server's /api/move/*
// (server/home/move-receive.mjs) with the move code its operator read on
// that computer.
//
// The request goes only to `https://<host name>` on port 443, never to an IP
// literal, and, as the calendar fetcher does (calendar-fetcher.mjs), only to
// a host whose every address is public; the connection is made to the
// address that was checked. The certificate is checked as for any HTTPS
// request. No redirect is followed. The code is sent in a header, once.
//
// A dropped piece is tried again (asking the home server how much it has),
// up to five times in a row; anything else ends the move with a code the
// admin's page explains.
//
// Test seam: `transport(request)` replaces the network. The service never
// passes one: it builds its sender without options.
import { lookup } from "node:dns/promises";
import { open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isLocalName, isPublicAddress } from "../web/calendar/feed-link.js";

const REQUEST_TIMEOUT_MS = 120_000;
const RETRIES = 5;
const MAX_ANSWER_BYTES = 64 * 1024;
/** Codes the sender itself reports (the home server's own pass through). */
export const SEND_ERROR_CODES = Object.freeze(["move-address-invalid", "move-address-refused", "move-unreachable", "move-timeout", "move-not-kin"]);

export class MoveSendError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "MoveSendError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * The home server's origin from what the admin typed: a host name, or an
 * https URL with nothing but a host name. Throws `move-address-invalid`.
 */
export function moveOrigin(address) {
  const text = String(address ?? "").trim();
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { url = null; }
  const host = url?.hostname.toLowerCase();
  if (!url || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash
    || !host || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || host.length > 253)
    throw new MoveSendError("move-address-invalid", "Type the home server's address, such as fern.home.kin.journeytocode.io.");
  return `https://${host}`;
}

async function systemResolve(host) {
  return lookup(host, { all: true, verbatim: true });
}

function readAnswer(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) { response.destroy(); reject(new MoveSendError("move-not-kin", "The home server's answer wasn't Kin's.")); return; }
      chunks.push(chunk);
    });
    response.on("end", () => {
      let value = null;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { value = null; }
      resolve({ status: response.statusCode ?? 0, body: value });
    });
    response.on("error", reject);
  });
}

export class MoveSender {
  constructor({ resolve = systemResolve, transport = null } = {}) {
    this.resolve = resolve;
    this.transport = transport;
  }

  /** The one address to connect to: every address must be public. */
  async vet(host) {
    if (isLocalName(host)) throw new MoveSendError("move-address-refused", "That address is a local one; Kin sends households only to public addresses.");
    let answers;
    try { answers = await this.resolve(host); } catch { throw new MoveSendError("move-unreachable", "Kin couldn't find that address."); }
    if (!Array.isArray(answers) || !answers.length) throw new MoveSendError("move-unreachable", "Kin couldn't find that address.");
    for (const answer of answers)
      if (!answer || !isIP(answer.address) || !isPublicAddress(answer.address))
        throw new MoveSendError("move-address-refused", "That address leads to a private or local network, which Kin won't send a household to.");
    return { address: answers[0].address, family: isIP(answers[0].address) };
  }

  /** One request to the home server: resolves { status, body } (JSON). */
  async request(origin, { method, path, headers = {}, body }) {
    if (this.transport) return this.transport({ origin, method, path, headers, body });
    const host = new URL(origin).hostname;
    const address = await this.vet(host);
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        hostname: host, port: 443, path, method, agent: false, servername: host, autoSelectFamily: false,
        lookup: (_name, options, callback) => {
          if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        },
        headers: { Host: host, "User-Agent": "Kin household move", Accept: "application/json", ...(body ? { "Content-Length": body.length } : {}), ...headers },
      }, (response) => readAnswer(response).then(resolve, reject));
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new MoveSendError("move-timeout", "The home server took too long to answer.")));
      request.on("error", (error) => reject(error instanceof MoveSendError ? error : new MoveSendError("move-unreachable", "Kin couldn't reach the home server.")));
      request.end(body);
    });
  }

  /** A request whose answer must be 2xx JSON; otherwise the home server's
   * own error code, or `move-not-kin`. */
  async #call(origin, options) {
    const answer = await this.request(origin, options);
    if (answer.status >= 200 && answer.status < 300 && answer.body && typeof answer.body === "object") return answer.body;
    const code = typeof answer.body?.error === "string" && /^[a-z0-9_-]{1,64}$/.test(answer.body.error) ? answer.body.error : null;
    if (!code || code === "not_found") throw new MoveSendError("move-not-kin", "That address didn't answer as a Kin home server.");
    throw new MoveSendError(code, typeof answer.body.message === "string" ? answer.body.message.slice(0, 300) : "The home server refused the household.", { status: answer.status, attemptsLeft: answer.body.attemptsLeft });
  }

  /**
   * Sends the package at `path` (`size` bytes, SHA-256 `sha256`) to
   * `origin` with `code`. `onProgress(sentBytes)` is called after each
   * piece. Resolves with the home server's receipt.
   */
  async send({ origin, code, path, size, sha256, onProgress = () => {} }) {
    const json = (value) => Buffer.from(JSON.stringify(value));
    const started = await this.#call(origin, { method: "POST", path: "/api/move/start", headers: { "Content-Type": "application/json", "Kin-Move-Code": String(code ?? "") }, body: json({ format: 1, size, sha256 }) });
    if (typeof started.token !== "string" || !Number.isSafeInteger(started.chunkBytes) || started.chunkBytes < 1)
      throw new MoveSendError("move-not-kin", "That address didn't answer as a Kin home server.");
    const bearer = { Authorization: `Bearer ${started.token}` };
    const file = await open(path, "r");
    try {
      let offset = 0;
      let failures = 0;
      while (offset < size) {
        const length = Math.min(started.chunkBytes, size - offset);
        const piece = Buffer.alloc(length);
        await file.read(piece, 0, length, offset);
        try {
          const answer = await this.#call(origin, { method: "PUT", path: `/api/move/chunk?offset=${offset}`, headers: { "Content-Type": "application/octet-stream", ...bearer }, body: piece });
          offset = answer.received;
          failures = 0;
          onProgress(offset);
        } catch (error) {
          // A dropped piece: ask where the home server is, and go on.
          if (!["move-unreachable", "move-timeout", "move-offset"].includes(error.code) || ++failures > RETRIES) throw error;
          const status = await this.#call(origin, { method: "GET", path: "/api/move/status", headers: bearer });
          offset = status.received;
        }
      }
    } finally {
      await file.close();
    }
    const receipt = await this.#call(origin, { method: "POST", path: "/api/move/finish", headers: bearer });
    if (receipt.moved !== true) throw new MoveSendError("move-not-kin", "The home server didn't confirm the household.");
    return receipt;
  }
}
