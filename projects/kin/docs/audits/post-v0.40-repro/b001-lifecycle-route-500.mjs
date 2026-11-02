// Post-v0.40 live verification reproduction B-001. Run from any directory: node <this file>. Requires Node >= 22.13.
// GET /api/household/lifecycle answered 500 for every household because the route read an out-of-scope
// `store` binding (ReferenceError). A revoked or removed device uses this unauthenticated lookup to tell
// lost access apart from household deletion. Fixed in this PR (server/server.mjs uses context.store);
// before the fix this script printed "route: 500".
import { pathToFileURL, fileURLToPath } from "node:url";
const KIN = fileURLToPath(new URL("../../../", import.meta.url));
const { PairingService } = await import(pathToFileURL(KIN + "server/pairing-service.mjs").href);
const { createKinServer } = await import(pathToFileURL(KIN + "server/server.mjs").href);
const { DurableStore } = await import(pathToFileURL(KIN + "server/durable-store.mjs").href);
const store = new DurableStore(":memory:");
const service = new PairingService({ store });
const adult = service.bootstrap({ credential: { id: "a", publicKey: "k", algorithm: -7 }, deviceLabel: "A" });
const app = createKinServer({ service, store });
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const response = await fetch(`${origin}/api/household/lifecycle?householdId=${adult.householdId}`);
console.log("route:", response.status, await response.text(), "(expected 200 active; was 500 before the fix)");
app.server.closeAllConnections();
await new Promise((resolve) => app.server.close(resolve));
store.close();
