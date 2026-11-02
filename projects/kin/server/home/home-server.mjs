// Home mode's reachability (ADR 0025 §1, §2, §5, §9; story #733): the
// tunnel to the connection relay, TLS ended in the service with the home
// server's own certificate, and the certificate manager.
//
//   TunnelStream (one per OPEN, tunnel-client.mjs)
//     → TLSSocket made here: the current certificate, plus the ACME hooks
//       (server/acme/tls-hook.mjs) that answer acme-tls/1 challenges
//     → Kin's existing http.Server, with server.emit("connection", tlsSocket)
//
// Why feed the existing http.Server rather than create an HTTPS one: every
// route, the /api/live WebSocket upgrade, the request limits, server.close()
// and its connection tracking already live on that one server. A second,
// HTTPS server would need all of them wired twice. The loopback listener
// stays plain HTTP for the control panel (#718); tunnel connections arrive
// on the same server already decrypted, exactly as https.Server does
// internally.
//
// Why make the TLSSocket here instead of tls.Server.emit("connection",
// stream): the client's address (from OPEN) must be attached to the very
// socket HTTP sees, and tls.Server never hands back the TLSSocket it wraps
// around a stream. The socket gets the same options a tls.Server would give
// it (the shared secure context, ALPNCallback and SNICallback), a handshake
// time limit, and its peer address set to the phone's.
import { readFileSync } from "node:fs";
import { TLSSocket, createSecureContext } from "node:tls";
import { trustTunnelPeer } from "../client-key.mjs";
import { CertificateStore } from "../acme/keys.mjs";
import { CertificateManager } from "../acme/renewal.mjs";
import { ChallengeResponder } from "../acme/tls-alpn.mjs";
import { acmeTlsServerOptions, isChallengeConnection } from "../acme/tls-hook.mjs";
import { createHttpsTransport } from "../acme/transport.mjs";
import { loadOrCreateHomeKey } from "./home-key.mjs";
import { TunnelClient } from "./tunnel-client.mjs";

export const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Kin's version as AUTH's softwareVersion:u32: major << 16 | minor << 8 |
 * patch (1.6.0 is 0x010600). The relay only records it. */
export function softwareVersionNumber(version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version) {
  const [major, minor, patch] = String(version).split(".").map((part) => Number.parseInt(part, 10) & 0xff);
  return ((major << 16) | (minor << 8) | patch) >>> 0;
}

/**
 * Ends TLS for tunnel streams. It stands in for a tls.Server where the
 * certificate manager expects one: `setSecureContext` swaps the certificate
 * for new connections (open ones keep theirs).
 */
export class HomeTlsEndpoint {
  constructor({ responder, onSecure, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS }) {
    this.hooks = acmeTlsServerOptions({ responder, alpnProtocols: ["http/1.1"] });
    this.onSecure = onSecure;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    // Until there is a certificate, ordinary handshakes fail (no certificate
    // to show); acme-tls/1 challenges still work, which is how the first
    // certificate is obtained.
    this.context = createSecureContext({ minVersion: "TLSv1.2" });
    this.hasCertificate = false;
    this.handshakes = 0;
  }

  setSecureContext({ key, cert }) {
    this.context = createSecureContext({ key, cert, minVersion: "TLSv1.2" });
    this.hasCertificate = true;
  }

  /** Ends TLS on `stream`; `open` is { address, family, name } from OPEN. */
  accept(stream, open) {
    const socket = new TLSSocket(stream, { isServer: true, secureContext: this.context, ...this.hooks });
    // The phone's address, as the relay reported it outside the HTTP
    // request: what the socket shows, and what rate limits key on (#736).
    Object.defineProperties(socket, {
      remoteAddress: { value: open.address, enumerable: true },
      remoteFamily: { value: open.family === 6 ? "IPv6" : "IPv4", enumerable: true },
      remotePort: { value: 0, enumerable: true },
    });
    trustTunnelPeer(socket, open.address);
    const timer = setTimeout(() => socket.destroy(), this.handshakeTimeoutMs);
    timer.unref?.();
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(timer); stream.destroy(); });
    socket.once("secure", () => {
      clearTimeout(timer);
      this.handshakes += 1;
      // RFC 8737 §3: a validation connection carries no application data.
      if (isChallengeConnection(socket)) { socket.end(); socket.destroySoon?.(); return; }
      this.onSecure(socket);
    });
    return socket;
  }
}

/**
 * Starts home mode's tunnel and certificate manager for a running Kin
 * server. `settings` are resolved home settings (settings.mjs) with a name.
 *
 * Test and private-relay seams (never set by home mode itself): `connectHost`
 * and `relayCa` for the tunnel, `directoryUrl`, `acmeTransport` and
 * `ctTransport` for ACME, `tunnel` for TunnelClient options and
 * `certificates` for CertificateManager options (such as `sleep`).
 * `onCertificateEvent(event)` hears the certificate manager's events
 * (renewed, failed, expiring, transparency-alert) after they are logged:
 * server.mjs turns the last two into an admin push (#718).
 *
 * Resolves with { tunnel, certificates, endpoint, status(), stop() }.
 */
export async function startHomeServer({
  application, dataDirectory, settings, softwareVersion = softwareVersionNumber(), log = () => {},
  connectHost, relayCa, directoryUrl, acmeTransport, ctTransport, ctBaseUrl, tunnel: tunnelOptions = {}, certificates: certificateOptions = {},
  onCertificateEvent = () => {},
}) {
  if (!settings?.configured) throw new TypeError("home settings with a name are required");
  const privateKey = await loadOrCreateHomeKey(dataDirectory);
  const responder = new ChallengeResponder();
  const endpoint = new HomeTlsEndpoint({ responder, onSecure: (socket) => application.server.emit("connection", socket) });
  const tunnel = new TunnelClient({
    relay: settings.relay, name: settings.name, freeName: settings.freeName, privateKey, softwareVersion,
    connectHost, ca: relayCa, log, ...tunnelOptions,
  });
  tunnel.on("stream", (stream) => endpoint.accept(stream, stream.open));
  const transport = acmeTransport ?? createHttpsTransport();
  const certificates = new CertificateManager({
    name: settings.name,
    store: new CertificateStore(dataDirectory),
    directoryUrl: directoryUrl ?? settings.acmeDirectory,
    transport,
    ctTransport: ctTransport ?? transport,
    ...(ctBaseUrl ? { ctBaseUrl } : {}),
    responder,
    server: endpoint,
    termsOfServiceAgreed: settings.acmeTermsAgreed,
    // ADR 0025 §5: the relay's DNS must name this ACME account in CAA
    // before the first order. It waits for the tunnel to route the name.
    beforeOrder: ({ accountUrl }) => tunnel.setCaa(accountUrl),
    ...certificateOptions,
    onEvent: (event) => {
      log({ event: `home_certificate_${event.type}`, ...(event.code ? { code: event.code } : {}), ...(event.notAfter ? { notAfter: event.notAfter } : {}) });
      try { onCertificateEvent(event); } catch { /* an alert must never stop renewal */ }
    },
  });
  await certificates.start();
  // A renewal that failed only because the tunnel wasn't up yet is tried
  // again as soon as the name is routed, not after the hour's backoff. A
  // failure from the CA (rate limits) keeps its backoff.
  tunnel.on("routed", () => {
    const status = certificates.status();
    if (status.lastError?.code?.startsWith("tunnel-") && !["valid", "renewing"].includes(status.state)) certificates.renew().catch(() => {});
  });
  tunnel.start();
  log({ event: "home_tunnel_started", relay: tunnel.status().relay, name: settings.name });
  return {
    tunnel,
    certificates,
    endpoint,
    publicKey: tunnel.publicKey,
    status: () => ({ tunnel: tunnel.status(), certificate: certificates.status() }),
    async stop() {
      certificates.stop();
      await tunnel.stop();
    },
  };
}
