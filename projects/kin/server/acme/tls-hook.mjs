// The home server's TLS hook for ACME (#726, #727; ADR 0025 §5 and §9).
//
// The only integration surface between the ACME code and the TLS server that
// home mode will run (server.mjs, tunnel story #733). It changes nothing by
// itself; the server spreads the options into `tls.createServer` (or
// `https.createServer`) and calls `closeChallengeConnections` once:
//
//   const server = https.createServer({
//     key, cert,                                  // the current certificate
//     ...acmeTlsServerOptions({ responder }),     // ALPNCallback + SNICallback
//   }, app);
//   closeChallengeConnections(server);
//   applyCertificate(server, { key, chainPem });  // later, on renewal
//
// How the choice is made. Node calls ALPNCallback (with the TLSSocket as
// `this`) while it processes the ClientHello, before the certificate callback
// that runs SNICallback (also with the socket as `this`). Checked on Node 22;
// the tests assert it, so CI on Node 24 confirms it too. So:
//
//   1. ALPNCallback: if the client offers "acme-tls/1" and the responder holds
//      an answer for the SNI name, remember the socket and select acme-tls/1.
//      A client offering only acme-tls/1 for a name with no pending answer is
//      refused (fatal no_application_protocol alert). Otherwise the first of
//      the server's own protocols the client offers is selected; acme-tls/1
//      is never selected for ordinary traffic.
//   2. SNICallback: a remembered socket gets the challenge certificate's
//      SecureContext; every other connection keeps the server's default
//      context, which `applyCertificate` swaps without a restart.
//   3. After the handshake a challenge connection is closed without reading
//      or writing application data (RFC 8737 §3); it never reaches HTTP.
import { ACME_TLS_ALPN } from "./tls-alpn.mjs";

const challengeSockets = new WeakSet();

/** True for a connection that negotiated the ACME validation protocol. */
export const isChallengeConnection = (socket) => challengeSockets.has(socket) || socket?.alpnProtocol === ACME_TLS_ALPN;

/**
 * `ALPNCallback` and `SNICallback` for the home server's TLS server.
 *
 * @param {object} options
 * @param {{ contextFor(name: string): import("node:tls").SecureContext | null, has(name: string): boolean }} options.responder
 * @param {string[]} [options.alpnProtocols] the server's own protocols, in preference order
 * @param {(name: string) => import("node:tls").SecureContext | null} [options.contextForName]
 *   a SecureContext for ordinary connections to `name`, or null for the
 *   server's default (the usual case: the home server has one name)
 */
export function acmeTlsServerOptions({ responder, alpnProtocols = ["http/1.1"], contextForName = () => null }) {
  if (!responder) throw new TypeError("a challenge responder is required");
  const own = alpnProtocols.filter((protocol) => protocol !== ACME_TLS_ALPN);
  return {
    ALPNCallback({ servername, protocols }) {
      if (protocols.includes(ACME_TLS_ALPN) && servername && responder.has(servername) && this && typeof this === "object") {
        challengeSockets.add(this);
        return ACME_TLS_ALPN;
      }
      return own.find((protocol) => protocols.includes(protocol));
    },
    SNICallback(servername, done) {
      try {
        if (this && challengeSockets.has(this)) {
          const context = responder.contextFor(servername);
          // The answer was removed between the two callbacks: fail the
          // handshake rather than show the real certificate under acme-tls/1.
          if (!context) { done(new Error("no ACME challenge for this name")); return; }
          done(null, context);
          return;
        }
        done(null, contextForName(servername) ?? undefined);
      } catch (error) {
        done(error);
      }
    },
  };
}

/** Close every acme-tls/1 connection as soon as its handshake ends, before
 * any other `secureConnection` listener (such as HTTPS) sees it. */
export function closeChallengeConnections(server) {
  server.prependListener("secureConnection", (socket) => {
    if (!isChallengeConnection(socket)) return;
    socket.pause();
    socket.end();
    socket.destroySoon?.();
  });
  return server;
}

/** Put a new certificate in place on a running `tls.Server` (or
 * `https.Server`) without a restart: new connections get it; open ones keep
 * the certificate they started with. */
export function applyCertificate(server, { key, chainPem }) {
  const keyPem = typeof key === "string" ? key : key.export({ type: "pkcs8", format: "pem" });
  server.setSecureContext({ key: keyPem, cert: chainPem });
}
