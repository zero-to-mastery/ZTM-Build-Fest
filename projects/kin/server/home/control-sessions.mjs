// Control-panel sessions on this computer (ADR 0025 §11, #719): after the
// one-time code, the browser on the home server's own computer gets a
// session, so the panel opens without a code next time. A session is a
// random 32-byte token in an HttpOnly, SameSite=Strict cookie scoped to
// /control; only its SHA-256 is stored, in `home/control-sessions.json`
// (mode 0600), so the sessions outlive the restart setup asks for. They
// last 30 days, at most eight are kept (the oldest goes), and signing out
// removes one.
//
// A session lets a browser see the panel and run setup. It is not a fresh
// confirmation: changes after setup still need one (control-panel.mjs).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { CertificateStore, readPrivateFile, writePrivateFile } from "../acme/keys.mjs";

export const SESSIONS_FILE = "control-sessions.json";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_SESSIONS = 8;
export const SESSION_COOKIE = "kin_control";

const hashOf = (token) => createHash("sha256").update(token, "utf8").digest("hex");
const isToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export class ControlSessions {
  #sessions = [];

  constructor({ dataDirectory, now = Date.now }) {
    this.store = new CertificateStore(dataDirectory);
    this.path = join(this.store.directory, SESSIONS_FILE);
    this.now = now;
  }

  /** Reads the stored sessions. A damaged file is replaced, not trusted:
   * the worst outcome is asking for a code again. */
  async load() {
    let parsed = null;
    try {
      const text = await readPrivateFile(this.path);
      parsed = text === null ? null : JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const list = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    this.#sessions = list.filter((entry) => typeof entry?.hash === "string" && /^[a-f0-9]{64}$/.test(entry.hash) && Number.isSafeInteger(entry.expiresAt));
    this.#prune();
    return this;
  }

  #prune() {
    const now = this.now();
    this.#sessions = this.#sessions.filter((entry) => entry.expiresAt > now).slice(-MAX_SESSIONS);
  }

  async #save() {
    await this.store.ensureDirectory();
    await writePrivateFile(this.path, `${JSON.stringify({ format: 1, sessions: this.#sessions }, null, 2)}\n`);
  }

  /** A new session; resolves with its token (for the cookie only). */
  async create() {
    const token = randomBytes(32).toString("base64url");
    this.#sessions.push({ hash: hashOf(token), createdAt: this.now(), expiresAt: this.now() + SESSION_TTL_MS });
    this.#prune();
    await this.#save();
    return token;
  }

  verify(token) {
    if (!isToken(token)) return false;
    const now = this.now();
    const wanted = Buffer.from(hashOf(token), "hex");
    let found = false;
    for (const entry of this.#sessions)
      if (entry.expiresAt > now && timingSafeEqual(Buffer.from(entry.hash, "hex"), wanted)) found = true;
    return found;
  }

  async revoke(token) {
    if (!isToken(token)) return;
    const hash = hashOf(token);
    const before = this.#sessions.length;
    this.#sessions = this.#sessions.filter((entry) => entry.hash !== hash);
    if (this.#sessions.length !== before) await this.#save();
  }

  get size() { this.#prune(); return this.#sessions.length; }
}
