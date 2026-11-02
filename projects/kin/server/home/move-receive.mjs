// Receiving a household moved from another Kin server (ADR 0026 §1, §3,
// #739). The old server sends this home server's own address the move
// package (server/move-package.mjs) in pieces, so a slow home connection or
// a dropped request costs one piece, not the whole household:
//
//   POST /api/move/start    Kin-Move-Code: the code the control panel printed
//                           { format: 1, size, sha256 } → { token, chunkBytes }
//   PUT  /api/move/chunk?offset=N   Authorization: Bearer <token>
//                           the next piece, at most chunkBytes → { received }
//   GET  /api/move/status   Bearer → { received, size }   (to resume)
//   POST /api/move/finish   Bearer → the receipt; Kin then restarts
//   DELETE /api/move        Bearer → the transfer is dropped
//
// The move code (ADR 0026 §1.1) is a one-time code like the control panel's
// others: printed to Kin's window and log, one hour, five tries, used once.
// It opens one transfer, whose bearer token (256 random bits, kept as its
// hash) lasts two hours. One transfer at a time. The package is written to
// `<data directory>/move/` and checked as a whole (size and SHA-256) before
// it is opened; then importMovePackage checks it as a Kin database and adds
// it in one transaction. Kin restarts afterwards, as after setup, so every
// part of the service loads the new household.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, statfsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "../acme/keys.mjs";
import { readBody, readJsonBody } from "../http-body.mjs";
import { MoveError, importMovePackage } from "../move-package.mjs";

export const MOVE_PREFIX = "/api/move/";
export const MAX_MOVE_BYTES = 4 * 1024 ** 3;
export const MOVE_CHUNK_BYTES = 8 * 1024 * 1024;
export const TRANSFER_TTL_MS = 2 * 60 * 60_000;
export const RECEIPT_FILE = "last-move.json";
/** Every code a receiving home server answers with (web/control/explain.js
 * has words for the ones its own page shows). */
export const MOVE_ERROR_CODES = Object.freeze([
  "move-code-wrong", "move-code-expired", "move-code-locked", "move-code-none", "move-code-malformed",
  "move-busy", "move-too-large", "move-no-space", "move-household-limit", "move-no-transfer", "move-offset",
  "move-incomplete", "move-checksum", "move-newer", "move-invalid", "move-clash", "move-username-taken", "move-import-failed",
]);

export const moveDirectory = (dataDirectory) => join(dataDirectory, "move");
const digest = (text) => createHash("sha256").update(text).digest();

class ReceiveError extends Error {
  constructor(code, message, status = 409, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function send(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

/**
 * The receiving end for one home server. `codes` is the control panel's
 * OneTimeCode for purpose "move"; `canAddHousehold()` says whether the
 * household limit has room; `restart(reason)` asks the launcher to start
 * Kin again.
 */
export class MoveReceiver {
  constructor({ dataDirectory, store, codes, canAddHousehold, restart = () => {}, log = () => {}, now = Date.now, maxBytes = MAX_MOVE_BYTES, chunkBytes = MOVE_CHUNK_BYTES, freeBytes }) {
    Object.assign(this, { dataDirectory, store, codes, canAddHousehold, restart, log, now, maxBytes, chunkBytes });
    this.freeBytes = freeBytes ?? (() => {
      try { const disk = statfsSync(dataDirectory); return Number(disk.bavail) * Number(disk.bsize); } catch { return null; }
    });
    this.transfer = null;
    this.finishing = false;
  }

  #active() {
    if (this.transfer && this.now() >= this.transfer.expiresAt) this.#drop("expired");
    return this.transfer;
  }

  #drop(reason) {
    if (!this.transfer) return;
    try { closeSync(this.transfer.descriptor); } catch { /* closed */ }
    rmSync(this.transfer.path, { force: true });
    for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(`${this.transfer.path}${suffix}`, { force: true });
    this.log({ event: "home_move_dropped", reason });
    this.transfer = null;
  }

  #authorize(request) {
    const transfer = this.#active();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(request.headers.authorization ?? ""));
    if (!transfer || !match || !timingSafeEqual(digest(match[1]), transfer.tokenHash))
      throw new ReceiveError("move-no-transfer", "There is no move under way with that token.", 401);
    return transfer;
  }

  /** Handles /api/move/*; resolves true when it answered. */
  async handle(request, response, url) {
    if (!url.pathname.startsWith(MOVE_PREFIX) && url.pathname !== "/api/move") return false;
    try {
      const route = url.pathname.slice(MOVE_PREFIX.length);
      if (request.method === "POST" && route === "start") send(response, 200, await this.#start(request, response));
      else if (request.method === "PUT" && route === "chunk") send(response, 200, await this.#chunk(request, response, url));
      else if (request.method === "GET" && route === "status") { const transfer = this.#authorize(request); send(response, 200, { received: transfer.received, size: transfer.size }); }
      else if (request.method === "POST" && route === "finish") await this.#finish(request, response);
      else if (request.method === "DELETE" && url.pathname === "/api/move") { this.#authorize(request); this.#drop("cancelled"); send(response, 200, { cancelled: true }); }
      else throw new ReceiveError("not_found", "That endpoint is unavailable.", 404);
    } catch (error) {
      if (error instanceof ReceiveError) send(response, error.status, { error: error.code, message: error.message, ...error.extra });
      else if (error instanceof MoveError) send(response, 422, { error: error.code, message: error.message });
      else if (error?.status === 413) send(response, 413, { error: "move-too-large", message: "That piece is too large." });
      else {
        this.log({ event: "home_move_failed", code: typeof error?.code === "string" ? error.code : "error" });
        send(response, 500, { error: "move-failed", message: "The home server couldn't take that." });
      }
    }
    return true;
  }

  async #start(request, response) {
    // The code is checked before anything else, so a guess costs a try.
    const answer = this.codes.verify(request.headers["kin-move-code"]);
    if (answer !== "ok")
      throw new ReceiveError(`move-code-${answer}`, "That move code didn't work.", answer === "wrong" ? 401 : 410, answer === "wrong" ? { attemptsLeft: this.codes.attemptsLeft } : {});
    let body;
    try { body = await readJsonBody(request, response, 4096); } catch { throw new ReceiveError("move-invalid", "The home server couldn't read that request.", 400); }
    if (body?.format !== 1 || !Number.isSafeInteger(body.size) || body.size < 1 || !/^[0-9a-f]{64}$/.test(String(body.sha256 ?? "")))
      throw new ReceiveError("move-invalid", "The home server couldn't read that request.", 400);
    if (this.#active() || this.finishing) throw new ReceiveError("move-busy", "Another move is under way here.");
    if (body.size > this.maxBytes) throw new ReceiveError("move-too-large", "That household is too large to move here.", 413, { maxBytes: this.maxBytes });
    const free = this.freeBytes();
    // The package, and the household once it is added, side by side.
    if (free !== null && free < body.size * 2) throw new ReceiveError("move-no-space", "This home server doesn't have room for that household.", 507);
    if (!this.canAddHousehold()) throw new ReceiveError("move-household-limit", "This home server's household limit is reached. Raise it in its control panel.");
    mkdirSync(moveDirectory(this.dataDirectory), { recursive: true, mode: 0o700 });
    const path = join(moveDirectory(this.dataDirectory), `incoming-${randomBytes(6).toString("hex")}.sqlite`);
    const token = randomBytes(32).toString("base64url");
    this.transfer = {
      tokenHash: digest(token), path, descriptor: openSync(path, "wx", 0o600), size: body.size, sha256: body.sha256,
      received: 0, hash: createHash("sha256"), expiresAt: this.now() + TRANSFER_TTL_MS,
    };
    this.log({ event: "home_move_started", bytes: body.size });
    return { token, chunkBytes: this.chunkBytes, received: 0 };
  }

  async #chunk(request, response, url) {
    const transfer = this.#authorize(request);
    const offset = Number(url.searchParams.get("offset"));
    if (!Number.isSafeInteger(offset) || offset !== transfer.received) {
      request.resume();
      throw new ReceiveError("move-offset", "That piece isn't the next one.", 409, { received: transfer.received });
    }
    const bytes = await readBody(request, response, this.chunkBytes, "That piece is too large.");
    if (bytes.length === 0 || transfer.received + bytes.length > transfer.size) {
      this.#drop("too-large");
      throw new ReceiveError("move-too-large", "More arrived than the move said.", 413);
    }
    writeSync(transfer.descriptor, bytes);
    transfer.hash.update(bytes);
    transfer.received += bytes.length;
    return { received: transfer.received };
  }

  async #finish(request, response) {
    const transfer = this.#authorize(request);
    request.resume();
    if (transfer.received !== transfer.size) throw new ReceiveError("move-incomplete", "Not everything has arrived yet.", 409, { received: transfer.received });
    if (transfer.hash.digest("hex") !== transfer.sha256) { this.#drop("checksum"); throw new ReceiveError("move-checksum", "What arrived doesn't match what was sent."); }
    closeSync(transfer.descriptor);
    this.finishing = true;
    try {
      const receipt = importMovePackage(this.store, transfer.path);
      const answer = { moved: true, householdId: receipt.householdId, members: receipt.members, devices: receipt.devices, events: receipt.events, receivedAt: new Date(this.now()).toISOString() };
      await writePrivateFile(join(moveDirectory(this.dataDirectory), RECEIPT_FILE), `${JSON.stringify({ format: 1, at: answer.receivedAt, members: receipt.members, events: receipt.events })}\n`);
      this.log({ event: "home_move_received", members: receipt.members, devices: receipt.devices, events: receipt.events });
      send(response, 200, answer);
      // Every part of the service loads the household as at startup.
      this.restart("move");
    } finally {
      this.finishing = false;
      this.transfer = null;
      rmSync(transfer.path, { force: true });
      for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(`${transfer.path}${suffix}`, { force: true });
    }
  }
}
