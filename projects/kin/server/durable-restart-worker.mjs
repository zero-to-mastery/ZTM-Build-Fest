import { createKinServer } from "./server.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";

const databasePath = process.env.KIN_RESTART_DATABASE_PATH;
const port = Number(process.env.KIN_RESTART_PORT);
const origin = `http://localhost:${port}`;
const store = new DurableStore(databasePath, { acquireProcessLock: true });
const service = new PairingService({ store });
const webauthn = {
  registrationOptions(flow) {
    return { challenge: flow };
  },
  verifyRegistration(credential) {
    return credential;
  },
  authenticationOptions(flow, credentialIds) {
    return {
      challenge: flow,
      allowCredentials: credentialIds.map((id) => ({ id })),
    };
  },
  verifyAuthentication() {
    return true;
  },
};
const application = createKinServer({
  host: "127.0.0.1",
  origin,
  port,
  service,
  store,
  webauthn,
});

application.server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "test_worker_ready", port }));
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!chunk.includes("shutdown")) return;
  application.server.close((error) => {
    store.close();
    process.exitCode = error ? 1 : 0;
  });
});
