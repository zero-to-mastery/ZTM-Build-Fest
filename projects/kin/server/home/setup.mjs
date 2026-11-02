// The setup flow (ADR 0025 §10, #719): what the first-run page on the home
// server's own computer walks through, as a small state machine.
//
//   name ──▶ terms ──▶ (own domain: records) ──▶ connect ══ restart ══▶ connecting ──▶ certificate ──▶ done
//    ▲                                                                     │
//    └──────────── the relay refused the name (taken, not allowed) ────────┘
//
// - name: a free name `<label>.<zone>` or the household's own domain, with a
//   live check through the relay (CONTROL CHECK) over a sign-in-only tunnel.
//   The relay's reserved names (www, relay, admin …) are the relay's to
//   refuse: its list lives in relay/registry.mjs, which a home server
//   doesn't ship, and an operator can extend it.
// - terms: the person agrees to the CA's terms (shown with a link). Until
//   then no ACME account exists and no certificate is ordered. For an own
//   domain the account is made here, because its CAA record names it.
// - records (own domain only): the exact DNS records, checked before going on.
// - connect: writes home/settings.json (0600) with the name and the terms
//   agreement and asks for a restart, so the service comes back serving
//   https://<name> (one origin per server: WebAuthn's relying party, the
//   cookies and the API's origin check all follow it). The tunnel, the claim
//   and the certificate are then the ordinary home-mode start
//   (home-server.mjs); this only reports their progress.
// - done: a certificate exists. The person opens https://<name> and creates
//   the household there with Kin's normal first run, because passkeys and
//   the device's storage belong to the real name, not to localhost.
//
// Choices before "connect" live in memory only: a restart before then just
// asks again. Once a certificate exists the name can't be changed here
// (changing it is a move, §12).
import { AcmeClient } from "../acme/client.mjs";
import { CertificateStore } from "../acme/keys.mjs";
import { createHttpsTransport } from "../acme/transport.mjs";
import { Resolver } from "node:dns/promises";
import { rawEd25519PublicKey } from "../../relay/ktun.mjs";
import { checkDomainRecords, expectedRecords } from "./domain-records.mjs";
import { loadOrCreateHomeKey } from "./home-key.mjs";
import { softwareVersionNumber } from "./home-server.mjs";
import { isHostName, writeHomeSettings } from "./settings.mjs";
import { TunnelClient } from "./tunnel-client.mjs";

export const SETUP_STEPS = Object.freeze(["name", "terms", "records", "connect", "connecting", "certificate", "done"]);
/** The tunnel's name errors that send setup back to choosing a name. */
const NAME_REFUSALS = new Set(["name-taken", "name-not-allowed", "name-limit"]);
/** How long the sign-in-only tunnel stays up after the last check. */
export const CHECK_TUNNEL_IDLE_MS = 2 * 60_000;

export class SetupError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SetupError";
    this.code = code;
    this.status = status;
  }
}

const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== "";

/**
 * What the person typed, as a full name: a bare label is a free name under
 * the zone; anything with a dot is a full name (free if it is one label
 * under the zone, else an own domain). Throws SetupError for anything that
 * can't be a name, with a code the page explains.
 */
export function interpretName(input, zone) {
  const text = String(input ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!text) throw new SetupError("setup-name-empty", "Type a name.");
  const name = text.includes(".") ? text : `${text}.${zone}`;
  if (!isHostName(name)) throw new SetupError("setup-name-invalid", "Use only letters a–z, digits and hyphens.");
  if (name === zone) throw new SetupError("setup-name-invalid", "Choose a name under the zone.");
  if (name.endsWith(`.${zone}`)) {
    const label = name.slice(0, -zone.length - 1);
    if (label.includes(".")) throw new SetupError("setup-name-invalid", "A free name is one word, without dots.");
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(label)) throw new SetupError("setup-name-length", "A free name is 3 to 40 letters, digits or hyphens, not starting or ending with a hyphen.");
    if (label[2] === "-" && label[3] === "-") throw new SetupError("setup-name-invalid", "A name can't have hyphens in both the third and fourth places.");
    return { name, freeName: true };
  }
  if (!name.includes(".")) throw new SetupError("setup-name-invalid", "An own domain has at least two parts, like kin.example.org.");
  return { name, freeName: false };
}

export class HomeSetup {
  /**
   * @param {object} options
   * @param {string} options.dataDirectory
   * @param {() => object} options.getSettings  the effective home settings now
   * @param {(settings: object) => void} options.setSettings  after writing them
   * @param {() => object|null} options.getHome  the running home server (home-server.mjs), if any
   * @param {(reason: string) => void} options.restart  ask the launcher to start the service again
   * @param {object} [options.env]
   * @param {object} [options.tunnel]  extra TunnelClient options (tests: connectHost, ca, backoff, interfaces)
   * @param {Function} [options.acmeTransport]
   * @param {Function} [options.checkDomain]  domain-records.mjs's checkDomainRecords stand-in
   * @param {object} [options.resolver]  a node:dns Resolver stand-in (tests)
   * @param {string} [options.directoryUrl]  an ACME directory instead of the settings' (tests: a loopback http one)
   * @param {(event: object) => void} [options.log]
   */
  constructor({ dataDirectory, getSettings, setSettings, getHome, restart, env = process.env, tunnel = {}, acmeTransport, checkDomain = checkDomainRecords, resolver = new Resolver({ timeout: 5_000, tries: 2 }), directoryUrl = null, log = () => {} }) {
    Object.assign(this, { dataDirectory, getSettings, setSettings, getHome, restart, env, tunnelOptions: tunnel, checkDomain, resolver, directoryOverride: directoryUrl, log });
    this.acmeTransport = acmeTransport ?? createHttpsTransport();
    this.draft = { name: null, freeName: null, termsAgreed: false, accountUrl: null, expected: null, records: null };
    this.checkTunnel = null;
    this.idleTimer = null;
    this.termsUrlCache = null;
    this.restarting = false;
  }

  get settings() { return this.getSettings(); }

  /** The ACME directory the certificate manager will use. */
  get directoryUrl() { return this.directoryOverride ?? this.settings.acmeDirectory; }

  /** A technical household set the name in KIN_HOME_NAME: the page shows
   * progress but can't change it. */
  get nameFromEnvironment() { return isSet(this.env.KIN_HOME_NAME); }

  #home() { return this.getHome?.() ?? null; }

  /** Whether the server has a certificate for its name: setup is over. */
  finished() {
    const certificate = this.#home()?.status().certificate;
    return Boolean(certificate?.certificate);
  }

  #assertChangeable() {
    if (this.finished()) throw new SetupError("setup-finished", "This home server is set up. Changing its name would be a move to a new address.", 409);
    if (this.nameFromEnvironment) throw new SetupError("setup-name-from-environment", "The name is set by KIN_HOME_NAME on this computer.", 409);
    if (this.restarting) throw new SetupError("setup-restarting", "Kin is restarting. Wait a moment.", 409);
  }

  // ---------------------------------------------------------------- views

  step() {
    const settings = this.settings;
    if (this.restarting) return "connecting";
    if (settings.configured) {
      const home = this.#home();
      if (!home) return "connecting";
      const { tunnel, certificate } = home.status();
      if (certificate.certificate) return "done";
      if (!tunnel.routed && NAME_REFUSALS.has(tunnel.nameError?.code) && !this.nameFromEnvironment) return this.draft.name && this.draft.name !== settings.name ? this.#draftStep() : "name";
      return tunnel.routed ? "certificate" : "connecting";
    }
    return this.#draftStep();
  }

  #draftStep() {
    if (!this.draft.name) return "name";
    if (!this.draft.termsAgreed || (!this.draft.freeName && !this.draft.accountUrl)) return "terms";
    if (!this.draft.freeName && !this.draft.records?.ok) return "records";
    return "connect";
  }

  /** Everything the setup page shows. No key, no address of anyone. */
  view() {
    const settings = this.settings;
    const status = this.#home()?.status() ?? null;
    const step = this.step();
    const drafting = ["name", "terms", "records", "connect"].includes(step) && this.draft.name !== null;
    const name = drafting ? this.draft.name : settings.name;
    return {
      step,
      zone: settings.zone,
      relay: `${settings.relay.host}${settings.relay.port === 443 ? "" : `:${settings.relay.port}`}`,
      name: name ?? null,
      freeName: drafting ? this.draft.freeName : settings.freeName,
      configuredName: settings.name,
      termsAgreed: this.draft.termsAgreed || settings.acmeTermsAgreed,
      nameFromEnvironment: this.nameFromEnvironment,
      expectedRecords: drafting && !this.draft.freeName ? this.draft.expected ?? null : null,
      records: drafting ? this.draft.records : null,
      origin: settings.configured ? `https://${settings.name}` : null,
      progress: status ? {
        tunnel: { state: status.tunnel.state, routed: status.tunnel.routed, error: status.tunnel.lastError?.code ?? null, nameError: status.tunnel.nameError?.code ?? null, nextAttemptAt: status.tunnel.nextAttemptAt },
        certificate: { state: status.certificate.state, error: status.certificate.lastError?.code ?? null, nextAttemptAt: status.certificate.nextAttemptAt, notAfter: status.certificate.certificate?.notAfter ?? null },
      } : null,
    };
  }

  // -------------------------------------------------------------- the name

  #tunnel() {
    const running = this.#home()?.tunnel;
    if (running) return running;
    if (!this.checkTunnel) {
      const settings = this.settings;
      this.checkTunnel = loadOrCreateHomeKey(this.dataDirectory).then((privateKey) => new TunnelClient({
        relay: settings.relay, name: null, freeName: true, privateKey, softwareVersion: softwareVersionNumber(), log: this.log, ...this.tunnelOptions,
      }).start());
      this.checkTunnel.catch(() => { this.checkTunnel = null; });
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.#stopCheckTunnel(), CHECK_TUNNEL_IDLE_MS);
    this.idleTimer.unref?.();
    return this.checkTunnel;
  }

  async #stopCheckTunnel() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const pending = this.checkTunnel;
    this.checkTunnel = null;
    if (pending) await (await pending.catch(() => null))?.stop();
  }

  /** The live availability check: resolves with { name, freeName, answer }
   * where answer is CHECK's (tunnel-client.mjs). A tunnel that can't sign
   * in rejects with its error code (relay-unreachable …). */
  async checkName(input) {
    const settings = this.settings;
    const { name, freeName } = interpretName(input, settings.zone);
    if (name === settings.relay.host) throw new SetupError("setup-name-not-allowed", "That is the relay's own name.");
    const tunnel = await this.#tunnel();
    let answer;
    try {
      answer = await tunnel.check(name);
    } catch (error) {
      throw new SetupError(typeof error?.code === "string" ? error.code : "relay-unreachable", "Kin couldn't ask the relay.", 503);
    }
    return { name, freeName, answer };
  }

  /** Chooses the name after a check. A name the relay says is taken or
   * not allowed is refused; "unknown" (an older relay) and, for an own
   * domain, "not-proven" (records come next) go on. */
  async chooseName(input) {
    this.#assertChangeable();
    const result = await this.checkName(input);
    const refusals = { taken: "setup-name-taken", "not-allowed": "setup-name-not-allowed", limit: "setup-name-limit" };
    if (refusals[result.answer]) throw new SetupError(refusals[result.answer], "The relay can't give this server that name.", 409);
    if (result.freeName && result.answer === "not-proven") throw new SetupError("setup-name-not-allowed", "The relay can't give this server that name.", 409);
    const sameAsBefore = this.draft.name === result.name;
    // The terms agreement and the ACME account carry over to another name;
    // the records were for the old one.
    this.draft = {
      ...this.draft,
      name: result.name,
      freeName: result.freeName,
      records: sameAsBefore ? this.draft.records : null,
      expected: sameAsBefore ? this.draft.expected : null,
    };
    if (!result.freeName && this.draft.accountUrl && !this.draft.expected) this.draft.expected = await this.expectedRecords();
    return this.view();
  }

  // ------------------------------------------------------------- the terms

  /** The CA's current terms of service, from its directory. */
  async termsUrl() {
    if (this.termsUrlCache) return this.termsUrlCache;
    const client = new AcmeClient({ directoryUrl: this.directoryUrl, accountKey: await new CertificateStore(this.dataDirectory).accountKey(), transport: this.acmeTransport });
    try {
      const directory = await client.directory();
      const url = directory?.meta?.termsOfService;
      this.termsUrlCache = typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
    } catch {
      this.termsUrlCache = null;
    }
    return this.termsUrlCache;
  }

  /** The person agrees to the CA's terms. For an own domain the ACME
   * account is made now: its CAA record must name it. */
  async agreeTerms(agreed) {
    this.#assertChangeable();
    if (agreed !== true) throw new SetupError("setup-terms-required", "Kin needs your agreement to get a certificate.");
    if (!this.draft.name) throw new SetupError("setup-name-first", "Choose a name first.", 409);
    if (!this.draft.freeName) {
      this.draft.accountUrl ??= await this.#ensureAccount();
      this.draft.expected ??= await this.expectedRecords();
    }
    this.draft.termsAgreed = true;
    return this.view();
  }

  async #ensureAccount() {
    const store = new CertificateStore(this.dataDirectory);
    const directoryUrl = this.directoryUrl;
    const stored = await store.account();
    if (stored?.directoryUrl === directoryUrl && stored.accountUrl) return stored.accountUrl;
    const client = new AcmeClient({ directoryUrl, accountKey: await store.accountKey(), transport: this.acmeTransport });
    try {
      await client.ensureAccount({ termsOfServiceAgreed: true });
    } catch (error) {
      throw new SetupError(typeof error?.code === "string" && error.code.startsWith("acme-") ? error.code : "acme-error", "The certificate authority didn't answer.", 503);
    }
    await store.saveAccount({ directoryUrl, accountUrl: client.accountUrl });
    return client.accountUrl;
  }

  // ----------------------------------------------- own domains: the records

  /** Checks an own domain's DNS records and asks the relay whether it sees
   * the TXT record. Keeps the result for the view. */
  async checkRecords() {
    this.#assertChangeable();
    if (!this.draft.name || this.draft.freeName) throw new SetupError("setup-records-not-needed", "A free name needs no DNS records.", 409);
    if (!this.draft.termsAgreed || !this.draft.accountUrl) throw new SetupError("setup-terms-required", "Agree to the certificate authority's terms first.", 409);
    const privateKey = await loadOrCreateHomeKey(this.dataDirectory);
    const result = await this.checkDomain({ domain: this.draft.name, relayHost: this.settings.relay.host, publicKey: rawEd25519PublicKey(privateKey), accountUrl: this.draft.accountUrl, resolver: this.resolver });
    // The relay's own view of the TXT record: it routes only after it sees it.
    if (result.ok) {
      let answer = "unknown";
      try { answer = (await this.checkName(this.draft.name)).answer; } catch { answer = "unknown"; }
      if (answer === "not-proven") result.checks.push({ id: "relay", ok: false, problem: "relay-txt-not-seen", found: [] });
      if (answer === "taken") result.checks.push({ id: "relay", ok: false, problem: "setup-name-taken", found: [] });
      result.ok = result.checks.every((check) => check.ok);
    }
    this.draft.records = { ...result, checkedAt: new Date().toISOString() };
    return this.view();
  }

  /** Shows the records before they are checked (an own domain, after the
   * terms): the expected values with nothing found yet. */
  async expectedRecords() {
    if (!this.draft.name || this.draft.freeName || !this.draft.accountUrl) return null;
    const relayAddresses = [
      ...(await this.resolver.resolve4(this.settings.relay.host).catch(() => [])),
      ...(await this.resolver.resolve6(this.settings.relay.host).catch(() => [])),
    ];
    return expectedRecords({ domain: this.draft.name, relayAddresses, publicKey: rawEd25519PublicKey(await loadOrCreateHomeKey(this.dataDirectory)), accountUrl: this.draft.accountUrl });
  }

  // ------------------------------------------------------------ connecting

  /** Writes the settings and asks for the restart that starts the tunnel,
   * the claim and the certificate under the new name. */
  async connect() {
    this.#assertChangeable();
    const step = this.#draftStep();
    if (step === "name") throw new SetupError("setup-name-first", "Choose a name first.", 409);
    if (step === "terms") throw new SetupError("setup-terms-required", "Agree to the certificate authority's terms first.", 409);
    if (step === "records") throw new SetupError("setup-records-not-ready", "The DNS records aren't all in place yet.", 409);
    const settings = await writeHomeSettings(this.dataDirectory, { name: this.draft.name, acmeTermsAgreed: true }, this.env);
    this.setSettings(settings);
    this.log({ event: "home_setup_connect", freeName: this.draft.freeName });
    await this.#stopCheckTunnel();
    this.restarting = true;
    this.restart("setup");
    return this.view();
  }

  /** Tries for the certificate again now (after fixing what its error
   * said), instead of waiting for the backoff. */
  async retryCertificate() {
    const home = this.#home();
    if (!home) throw new SetupError("setup-not-connected", "The home server isn't connected yet.", 409);
    home.certificates.renew().catch(() => {});
    return this.view();
  }

  async close() {
    await this.#stopCheckTunnel();
  }
}
