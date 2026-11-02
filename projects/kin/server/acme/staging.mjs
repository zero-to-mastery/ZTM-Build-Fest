#!/usr/bin/env node
// A manual check against Let's Encrypt **staging** (#723). Never run by the
// tests or CI. It needs a machine where <name> resolves to it and port 443
// (or --port, if something forwards 443 there) is reachable from the
// internet, because the CA validates with TLS-ALPN-01. Until the tunnel
// (#733) exists, that means a test name with your own DNS and a forwarded
// port. See docs/HOME-CERTIFICATES.md.
//
//   node server/acme/staging.mjs --name test.example.org --data-dir /tmp/kin-staging --agree-terms
//
// It starts a TLS server with the ACME hook, obtains one certificate into
// <data-dir>/home/, runs the CT check, prints the status and exits.
import { createServer } from "node:tls";
import { parseArgs } from "node:util";
import { LETS_ENCRYPT_STAGING } from "./client.mjs";
import { CertificateStore } from "./keys.mjs";
import { CertificateManager } from "./renewal.mjs";
import { ChallengeResponder } from "./tls-alpn.mjs";
import { acmeTlsServerOptions, closeChallengeConnections } from "./tls-hook.mjs";
import { createHttpsTransport } from "./transport.mjs";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    "data-dir": { type: "string" },
    port: { type: "string", default: "443" },
    host: { type: "string", default: "0.0.0.0" },
    directory: { type: "string", default: LETS_ENCRYPT_STAGING },
    "agree-terms": { type: "boolean", default: false },
  },
});

if (!values.name || !values["data-dir"]) {
  console.error("usage: node server/acme/staging.mjs --name <dns name> --data-dir <directory> --agree-terms [--port 443] [--directory <ACME directory URL>]");
  process.exit(2);
}
if (values.directory === "https://acme-v02.api.letsencrypt.org/directory") {
  console.error("this script is for staging; production certificates count against Let's Encrypt's rate limits");
  process.exit(2);
}

const responder = new ChallengeResponder();
const server = createServer({ ...acmeTlsServerOptions({ responder }) }, (socket) => socket.end());
closeChallengeConnections(server);
await new Promise((resolve) => server.listen(Number(values.port), values.host, resolve));

const manager = new CertificateManager({
  name: values.name,
  store: new CertificateStore(values["data-dir"]),
  directoryUrl: values.directory,
  transport: createHttpsTransport(),
  responder,
  server,
  termsOfServiceAgreed: values["agree-terms"],
  beforeOrder: async ({ caa }) => console.log(`CAA for this account (publish before production use):\n  ${caa.join("\n  ")}`),
});

let exitCode = 0;
try {
  await manager.renew();
  await manager.checkTransparency().catch(() => {});
} catch {
  exitCode = 1;
}
console.log(JSON.stringify(manager.status(), null, 2));
manager.stop();
server.close();
process.exitCode = exitCode;
