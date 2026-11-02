// Moving a household to a home server, end to end (ADR 0026, #738, #739):
// a hosted Kin and a home Kin with its control panel, both real, in one
// process. The sender's network is replaced by plain HTTP to the home server
// on loopback (its address guard is tested on its own below); everything
// else is the real path: readiness, the admin's fresh confirmation, the
// frozen household, the package, the pieces, the import, the moved state,
// undo and closing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { HouseholdMoves, UNDO_WINDOW_MS } from "./household-move.mjs";
import { MoveSender, moveOrigin } from "./move-sender.mjs";
import { PairingError } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { createControlPanel } from "./home/control-panel.mjs";
import { resolveHomeSettings } from "./home/settings.mjs";

const TIMEOUT = { timeout: 60_000 };
const HOSTED = "https://kin.example.test";
const HOME = "fern.home.kin.journeytocode.io";
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

function stubWebAuthn() {
  return {
    registrationOptions: (flow) => ({ challenge: flow }),
    authenticationOptions: (flow, credentialIds) => ({ challenge: flow, allowCredentials: credentialIds.map((id) => ({ id })) }),
    verifyRegistration: (response) => ({ id: response.id, publicKey: `key-${response.id}`, algorithm: -7, signCount: 0 }),
    verifyAuthentication(response, flow, registered) {
      if (!registered || response?.id !== registered.id) throw new PairingError("passkey_verification_failed", "Invalid passkey.", 401);
      return true;
    },
    discardFlow() {},
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(application) {
  application.server.closeAllConnections?.();
  return new Promise((resolve) => application.server.close(resolve));
}

/** A request with full control of headers; JSON or raw bytes. */
function call(port, path, { method = "GET", host, headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, agent: false, headers: {
      host, ...(payload ? { "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json", "content-length": payload.length } : {}), ...headers,
    } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let parsed = Buffer.concat(chunks).toString("utf8");
        try { parsed = JSON.parse(parsed); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

/** The two servers, the household on the hosted one, and helpers. */
async function servers(t, { now = Date.now } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kin-household-move-"));
  // The home server: set up, with its certificate (a stand-in), on loopback.
  const homeStore = new DurableStore(join(directory, "home.sqlite"), { acquireProcessLock: false });
  const home = createKinServer({ store: homeStore, mode: "home", webauthn: stubWebAuthn(), origin: `https://${HOME}`, host: "127.0.0.1", moveLog: () => {} });
  home.home = { certificates: { status: () => ({ certificate: { notAfter: "2027-01-20T00:00:00.000Z" } }) }, tunnel: { status: () => null } };
  const printed = [];
  const restarts = [];
  const panel = await createControlPanel({
    application: home, dataDirectory: join(directory, "home-data"), settings: resolveHomeSettings({ format: 1, name: HOME, acmeTermsAgreed: true }, {}), env: {},
    log: (event) => { if (event.event === "home_control_code") printed.push(event); }, restart: (reason) => restarts.push(reason),
  });
  const homePort = await listen(home.server);
  // The sender reaches the home server here, as it would through the relay.
  const transport = ({ origin, method, path, headers, body }) => {
    assert.equal(origin, `https://${HOME}`);
    return call(homePort, path, { method, host: HOME, headers, body });
  };
  // The hosted service, with one household and an admin who has a password.
  const hostedStore = new DurableStore(join(directory, "hosted.sqlite"), { acquireProcessLock: false });
  const hosted = createKinServer({
    store: hostedStore, webauthn: stubWebAuthn(), origin: HOSTED, host: "127.0.0.1", now,
    moveSender: new MoveSender({ transport }), moveWorkDirectory: join(directory, "moves"), moveLog: () => {},
  });
  const hostedPort = await listen(hosted.server);
  const admin = hosted.service.bootstrap({ credential: credential("move-admin"), deviceLabel: "Synthetic laptop" });
  t.after(async () => {
    await hosted.householdMoves?.jobs.get(admin.householdId)?.running;
    await Promise.all([close(hosted), close(home), panel.close()]);
    hostedStore.close();
    homeStore.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const cookie = `kin_session=${admin.sessionToken}; kin_device=${admin.deviceToken}`;
  const app = (path, body, { headers = {} } = {}) => call(hostedPort, path, { method: body === undefined ? "GET" : "POST", host: new URL(HOSTED).host, body, headers: { origin: HOSTED, cookie, ...headers } });
  const givePassword = () => {
    const wrapped = Buffer.alloc(61, 3);
    wrapped[0] = 1;
    const vault = Buffer.alloc(120, 7);
    vault.write("KVLT", 0, "latin1");
    vault[4] = 1;
    hostedStore.putAccountVault(admin.householdId, admin.memberId, {
      expectedVersion: 0, ciphertext: vault, now: 1,
      wrappers: [{ wrapperId: "1".repeat(32), type: "password", version: 1, params: { kdf: "pbkdf2-sha256", iterations: 600_000, salt: Buffer.alloc(16, 9).toString("base64") }, wrapped }],
    });
    hostedStore.putAccountPassword(admin.householdId, admin.memberId, { salt: new Uint8Array(16).fill(1), iterations: 600_000, verifier: "$argon2id$v=19$m=19456,t=2,p=1$x$y", now: 2 });
  };
  const moveCode = async () => {
    panel.codes.move.issue({ force: true });
    const issued = panel.issueCode("move", { force: true });
    assert.ok(issued.expiresAt);
    return printed.at(-1).code;
  };
  /** Starts a move as the admin's page does: options, then finish. */
  const startMove = async (code, address = HOME) => {
    const options = await app("/api/household/move/options", { address });
    if (options.status !== 200) return options;
    return app("/api/household/move/finish", { flow: options.body.flow, credential: { id: "move-admin" }, code });
  };
  const settle = () => hosted.householdMoves.jobs.get(admin.householdId)?.running;
  return { hosted, home, homeStore, hostedStore, panel, admin, app, givePassword, moveCode, startMove, settle, restarts, hostedPort };
}

test("the address: a host name over https, nothing else", () => {
  assert.equal(moveOrigin("Fern.home.kin.journeytocode.io"), "https://fern.home.kin.journeytocode.io");
  assert.equal(moveOrigin("https://kin.smith.family/"), "https://kin.smith.family");
  for (const bad of ["http://kin.smith.family", "https://kin.smith.family:8443", "https://kin.smith.family/path", "https://user@kin.smith.family", "192.0.2.10", "https://[2001:db8::1]", "localhost", ""])
    assert.throws(() => moveOrigin(bad), { code: "move-address-invalid" }, bad);
});

test("the sender goes only to public addresses", async () => {
  const sender = (answers) => new MoveSender({ resolve: async () => answers });
  await assert.rejects(sender([{ address: "10.0.0.5", family: 4 }]).vet("kin.smith.family"), { code: "move-address-refused" });
  await assert.rejects(sender([{ address: "203.0.113.9", family: 4 }, { address: "127.0.0.1", family: 4 }]).vet("kin.smith.family"), { code: "move-address-refused" }, "every address must be public");
  await assert.rejects(sender([]).vet("kin.smith.family"), { code: "move-unreachable" });
  await assert.rejects(sender([{ address: "8.8.8.8", family: 4 }]).vet("printer.local"), { code: "move-address-refused" });
  assert.deepEqual(await sender([{ address: "8.8.8.8", family: 4 }]).vet("kin.smith.family"), { address: "8.8.8.8", family: 4 });
});

test("a household moves: readiness, a fresh confirmation, frozen while it goes, then moved and pointing at the new address", TIMEOUT, async (t) => {
  const context = await servers(t);
  const { app, admin } = context;
  // Nobody could sign in at the new address yet: no password, no backup code.
  const before = await app("/api/household/move");
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.readiness, { members: [{ memberId: admin.memberId, kind: "adult", admin: true, account: false, ready: null }], canStart: false });
  assert.equal(before.body.move.state, "none");
  assert.equal((await app("/api/household/move/options", { address: HOME })).body.error, "move_no_ready_admin");
  context.givePassword();
  assert.equal((await app("/api/household/move")).body.readiness.canStart, true);
  assert.equal((await app("/api/household/move/options", { address: "https://kin.example.test" })).body.error, "move-address-invalid", "not to itself");
  // The move: started with a fresh passkey and the printed code.
  const code = await context.moveCode();
  const started = await context.startMove(code);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.state, "sending");
  assert.equal(started.body.targetOrigin, `https://${HOME}`);
  // Frozen while it goes: the household's sessions wait.
  assert.throws(() => context.hosted.service.authorize(admin.sessionToken), { code: "household_moving" });
  assert.equal((await app("/api/household/move")).status, 200, "the admin can follow it");
  await context.settle();
  // Arrived: the home server has it and restarts to load it.
  assert.equal(context.homeStore.db.prepare("SELECT COUNT(*) AS n FROM households WHERE id = ?").get(admin.householdId).n, 1);
  assert.deepEqual(context.restarts, ["move"]);
  // Moved: every session is refused with the new address; the device's
  // status says where to go, and the admin may undo or close it.
  assert.throws(() => context.hosted.service.authorize(admin.sessionToken), (error) => error.code === "household_moved" && error.message.includes(`https://${HOME}`));
  const refused = await app("/api/sync/status");
  assert.equal(refused.status, 410);
  assert.equal(refused.body.error, "household_moved");
  const status = await app("/api/status");
  assert.equal(status.body.identity, null);
  assert.deepEqual(
    { state: status.body.householdLifecycle.state, movedTo: status.body.householdLifecycle.movedTo, admin: status.body.householdLifecycle.admin },
    { state: "moved", movedTo: `https://${HOME}`, admin: true },
  );
  assert.ok(Date.parse(status.body.householdLifecycle.undoUntil) > Date.now());
  assert.ok(Date.parse(status.body.householdLifecycle.remindAt) > Date.parse(status.body.householdLifecycle.undoUntil));
  // Closing it: the existing deletion, through the trusted device.
  const options = await app("/api/household/move/close/options", {});
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const closed = await app("/api/household/move/close/finish", { flow: options.body.flow, credential: { id: "move-admin" } });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.state, "deletion_pending");
  assert.equal(context.hosted.service.households.get(admin.householdId).lifecycleState, "deletion_pending");
});

test("a move that fails leaves the household in use where it was, and says why", TIMEOUT, async (t) => {
  const context = await servers(t);
  context.givePassword();
  await context.moveCode();
  const started = await context.startMove("22222-22222");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await context.settle();
  const after = (await context.app("/api/household/move")).body.move;
  assert.equal(after.state, "none");
  assert.equal(after.lastError.code, "move-code-wrong");
  assert.equal(after.lastError.attemptsLeft, 4);
  assert.ok(context.hosted.service.authorize(context.admin.sessionToken), "in use again");
  assert.equal(context.homeStore.db.prepare("SELECT COUNT(*) AS n FROM households").get().n, 0);
});

test("a move can be undone for a day, through the trusted device", TIMEOUT, async (t) => {
  let time = Date.now();
  const context = await servers(t, { now: () => time });
  context.givePassword();
  await context.startMove(await context.moveCode());
  await context.settle();
  assert.equal(context.hosted.service.householdMoves.get(context.admin.householdId).state, "moved");
  const options = await context.app("/api/household/move/undo/options", {});
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const undone = await context.app("/api/household/move/undo/finish", { flow: options.body.flow, credential: { id: "move-admin" } });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.state, "none");
  assert.ok(context.hosted.service.authorize(context.admin.sessionToken), "in use here again");
  // A day later it can't be.
  const moves = context.hosted.householdMoves;
  context.hostedStore.putHouseholdMove({ householdId: context.admin.householdId, state: "moved", targetOrigin: `https://${HOME}`, startedByMemberId: context.admin.memberId, startedAt: time, movedAt: time });
  context.hosted.service.householdMoves.set(context.admin.householdId, context.hostedStore.loadHouseholdMoves().get(context.admin.householdId));
  time += UNDO_WINDOW_MS;
  assert.throws(() => moves.undo(context.admin.householdId), { code: "move_undo_expired" });
});

test("a send cut short by a restart leaves the household in use", () => {
  const store = new DurableStore(":memory:");
  try {
    const service = { householdMoves: new Map(), households: new Map(), members: new Map() };
    store.db.prepare("INSERT INTO households (id, version) VALUES (?, 1)").run("h".repeat(32));
    const move = store.putHouseholdMove({ householdId: "h".repeat(32), state: "sending", targetOrigin: `https://${HOME}`, startedByMemberId: "m", startedAt: 1 });
    service.householdMoves.set(move.householdId, move);
    const moves = new HouseholdMoves({ service, store, workDirectory: tmpdir(), origin: HOSTED, log: () => {} });
    assert.equal(service.householdMoves.size, 0);
    assert.equal(store.loadHouseholdMoves().size, 0);
    assert.equal(moves.status("h".repeat(32)).lastError.code, "move-interrupted");
  } finally {
    store.close();
  }
});
