// Captures the household workspace at representative widths with synthetic
// data: Today, Shopping, an open item, search, routines and the household hub,
// in light and dark schemes, plus empty and failed-save states. Writes PNGs to
// target/ux-screenshots/ (ignored) and fails on uncaught page errors.
//
//   node scripts/workspace-screenshots.mjs <browser executable>
//
// Uses a fresh temporary profile and a loopback static server; never an
// existing Kin database. No npm packages required.
import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const executable = process.argv[2];
assert.ok(executable, "Usage: node scripts/workspace-screenshots.mjs <browser executable>");
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const outDir = resolve(webRoot, "../target/ux-screenshots");
await mkdir(outDir, { recursive: true });
const recovery = randomBytes(32).toString("hex");
const profile = await mkdtemp(join(tmpdir(), "kin-shots-"));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/api/status") { response.setHeader("Content-Type", "application/json"); response.end('{"identity":null,"claim":null}'); return; }
  const path = resolve(webRoot, `.${pathname.replace(/\/$/, "/index.html")}`);
  if (!path.startsWith(webRoot + sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" }[extname(path)] ?? "application/octet-stream");
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const problems = [];
let client;
let browserClient;

async function until(check, label = "browser state") {
  for (let i = 0; i < 300; i++) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const task = pending.get(message.id); pending.delete(message.id); message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result); }
    else if (message.method === "Runtime.exceptionThrown") problems.push(message.params.exceptionDetails);
    else if (message.method === "Log.entryAdded" && message.params.entry.level === "error" && !message.params.entry.url?.endsWith("/favicon.ico")) problems.push(message.params.entry);
  };
  return {
    send: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id: n, method, params })); }),
    async evaluate(expression) {
      const source = typeof expression === "function" ? `(${expression.toString()})()` : expression;
      const result = await this.send("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

const shot = async (name) => {
  await client.evaluate("window.scrollTo(0,0)");
  await delay(120);
  const { data } = await client.send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`saved ${name}.png`);
};
const viewport = (width, height, mobile) => setViewport(client, { width, height, deviceScaleFactor: 1, mobile });
const scheme = (value) => setMedia(client, [{ name: "prefers-color-scheme", value }]);
const visit = async (hash) => { await client.evaluate(`document.querySelector('kin-app').ctx.navigation.navigate(${JSON.stringify(hash)})`); await delay(60); };

try {
  const port = await until(async () => { try { return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { return false; } });
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  console.log(`Browser: ${version.Browser}; Node: ${process.version}`);
  browserClient = await connect(version.webSocketDebuggerUrl);
  const target = await (await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })).json();
  client = await connect(target.webSocketDebuggerUrl);
  for (const domain of ["Runtime", "Page", "Log", "Network"]) await client.send(`${domain}.enable`);
  await viewport(1440, 960, false);
  // Start light, so the first shots do not follow the computer's theme (#795).
  await setMedia(client);
  await client.send("Page.navigate", { url: origin });
  await until(() => client.evaluate('Boolean(document.querySelector("kin-app")?.security?.heading)'), "shell");
  await shot("1440-locked-welcome");
  await client.evaluate(`document.querySelector("kin-app").security.establishProtection(${JSON.stringify(recovery)})`);
  await until(() => client.evaluate('Boolean(document.querySelector("kin-app")?.store && !document.querySelector("kin-app").busy)'), "unlock");
  await shot("1440-today-empty");

  // Synthetic household: long names, duplicates, steps, dates, pins, routines.
  await client.evaluate(`(async () => {
    const app = document.querySelector("kin-app");
    const idle = async () => { for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 400; i++) await new Promise((r) => setTimeout(r, 10)); };
    const add = async (command) => { await app.ctx.append.appendCommand(command); await idle(); return app.state.items.at(-1); };
    const today = app.ctx.navigation.currentCivilDate();
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 3); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
    const dentist = await add({ type: "add", text: "Call the dentist about Sam's retainer appointment and ask whether the Thursday slot is still open", classification: "need" });
    await add({ type: "set-item-planning-date", itemId: dentist.itemId, planningDate: today });
    const eggs = await add({ type: "add", text: "Eggs", classification: "shopping" });
    await add({ type: "set-item-planning-date", itemId: eggs.itemId, planningDate: today });
    const eggs2 = await add({ type: "add", text: "Eggs", classification: "shopping" });
    const bins = await add({ type: "add", text: "Put the bins out", classification: "need" });
    await add({ type: "set-item-planning-date", itemId: bins.itemId, planningDate: yesterday });
    const forms = await add({ type: "add", text: "School forms", classification: "need" });
    await add({ type: "set-item-planning-date", itemId: forms.itemId, planningDate: tomorrow });
    await add({ type: "add", text: "Oat milk", classification: "shopping" });
    await add({ type: "add", text: "Dishwasher tablets", classification: "staple" });
    const trip = await add({ type: "add", text: "Pack for the weekend trip", classification: "need" });
    for (const text of ["Chargers", "Snacks for the car", "Swim things"]) { await add({ type: "add-item-step", itemId: trip.itemId, stepId: crypto.randomUUID().replaceAll("-", ""), text }); }
    await add({ type: "complete-item-step", itemId: trip.itemId, stepId: app.state.items.find((i) => i.itemId === trip.itemId).steps[0].stepId });
    await add({ type: "pin", targetKind: "item", targetId: trip.itemId });
    const done = await add({ type: "add", text: "Water the plants", classification: "need" });
    await add({ type: "set-item-planning-date", itemId: done.itemId, planningDate: today });
    await add({ type: "complete", itemId: done.itemId });
    await app.ctx.append.appendCommand({ type: "create-routine", text: "Take the recycling out", cadence: "weekly", createdOn: today }); await idle();
    await app.ctx.append.appendCommand({ type: "create-routine", text: "Wipe the counters", cadence: "daily", createdOn: today }); await idle();
    await app.ctx.append.appendCommand({ type: "add-handoff", text: "Pickup is 3:10 Thursday. Spare key is in the blue bowl." }); await idle();
    await app.ctx.append.appendCommand({ type: "add-talk", text: "Holiday plans for December" }); await idle();
    await app.ctx.append.appendCommand({ type: "create-note", noteId: crypto.randomUUID().replaceAll("-", ""), id: undefined, title: "Wi-Fi", body: "Network: Kinhouse\\nPassword is in the kitchen drawer", areaId: null }).catch(() => {}); await idle();
    app.ctx.render.renderState();
    window.__kinSeed = { dentist: dentist.itemId, eggs: eggs.itemId, trip: trip.itemId, eggs2: eggs2.itemId };
  })()`);
  await visit("#today");
  // Mark catch-up as read so the Today composition itself is in view.
  await client.evaluate(`(async () => { const app = document.querySelector("kin-app"); app.catchUp.button.click(); for (let i = 0; app.busy && i < 400; i++) await new Promise((r) => setTimeout(r, 10)); app.passkeyPromptDismissed = true; app.onboarding.hidden = true; })()`);
  for (const [name, mode] of [["light", "light"], ["dark", "dark"]]) {
    await scheme(mode);
    await viewport(1440, 960, false);
    await shot(`1440-today-${name}`);
    if (mode === "dark") continue;
    await visit("#lists/shopping");
    await shot("1440-shopping");
    await client.evaluate(`document.querySelector('kin-app').ctx.detail.openItemDetail(window.__kinSeed.trip)`);
    await delay(80);
    await visit("#lists/todo");
    await client.evaluate(`document.querySelector('kin-app').ctx.detail.openItemDetail(window.__kinSeed.trip)`);
    await delay(80);
    await shot("1440-todo-detail-open");
    await viewport(1920, 1080, false);
    await shot("1920-todo-detail-open");
    await viewport(1024, 800, false);
    await shot("1024-todo-detail-inline");
    await viewport(768, 1024, false);
    await shot("768-todo-detail-inline");
    await viewport(390, 844, true);
    await delay(80);
    await shot("390-todo-detail-sheet");
    await client.evaluate(`document.querySelector('kin-app').ctx.detail.closeItemDetail({ restoreFocus: false })`);
    await visit("#today");
    await shot("390-today");
    await client.evaluate(`document.querySelector('kin-app').ctx.detail.openItemDetail(window.__kinSeed.dentist)`);
    await delay(80);
    await shot("390-today-item-sheet");
    await client.evaluate(`document.querySelector('kin-app').ctx.detail.closeItemDetail({ restoreFocus: false })`);
    await viewport(360, 780, true);
    await shot("360-today");
    await visit("#lists/shopping");
    await shot("360-shopping");
    await scheme("dark");
    await shot("360-shopping-dark");
    await scheme("light");
    await viewport(1440, 960, false);
    await visit("#routines");
    await shot("1440-routines");
    await visit("#updates/handoffs");
    await shot("1440-updates");
    await visit("#household");
    await shot("1440-household");
    await visit("#household/privacy");
    await shot("1440-household-privacy");
    await visit("#search");
    await client.evaluate(`(() => { const s = document.querySelector('kin-app').search; s.queryInput.value = 'eggs'; s.queryInput.dispatchEvent(new Event('input')); })()`);
    await shot("1440-search");
    // Failed save: inject a storage failure for one add from the Today capture.
    await visit("#today");
    await client.evaluate(`(async () => {
      const app = document.querySelector("kin-app");
      const original = app.store.append.bind(app.store);
      app.store.append = async () => { const error = new Error("Synthetic failure"); error.code = 5; error.userMessage = "Kin could not save that change locally."; throw error; };
      app.compose.input.value = "Book the car service";
      app.compose.form.requestSubmit();
      for (let i = 0; app.busy && i < 400; i++) await new Promise((r) => setTimeout(r, 10));
      app.store.append = original;
    })()`);
    await shot("1440-today-failed-save");
    await viewport(390, 844, true);
    await shot("390-today-failed-save");
    await client.evaluate(`(() => { const app = document.querySelector("kin-app"); app.ctx.status.clearAlert(); app.compose.clearResult(); app.compose.input.value = ""; window.dispatchEvent(new Event("offline")); })()`);
    await shot("390-today-offline");
    await client.evaluate(`window.dispatchEvent(new Event("online"))`);
    await viewport(1440, 960, false);
    await visit("#today");
  }
  // Personal Appearance evidence uses only synthetic pixels and the editor's
  // real preview/application path. It never touches household events.
  await viewport(1440, 960, false);
  await scheme("light");
  await visit("#household/appearance");
  await shot("appearance-1440-default");
  await client.evaluate(`(() => { const a=document.querySelector('kin-app').appearance; a.choosePreset({id:'plum',name:'Plum',seed:'#74507D'}); })()`);
  await shot("appearance-1440-plum-light");
  await client.evaluate(`(() => { const a=document.querySelector('kin-app').appearance; a.change({mode:'dark'}); })()`);
  await shot("appearance-1440-plum-dark");
  await viewport(768, 1024, false);
  await client.evaluate(`(() => { const a=document.querySelector('kin-app').appearance; a.chooseCustom('#16756F'); })()`);
  await shot("appearance-768-custom");
  await client.evaluate(`(async () => {
    const a=document.querySelector('kin-app').appearance;
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=400;
    const c=canvas.getContext('2d');const g=c.createLinearGradient(0,0,640,400);g.addColorStop(0,'#174f86');g.addColorStop(1,'#e58a35');c.fillStyle=g;c.fillRect(0,0,640,400);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.85));
    const image={bytes:new Uint8Array(await blob.arrayBuffer()),type:blob.type,width:640,height:400,seed:'#276A91'};
    a.draft={...a.draft,image,colorSource:'background',seed:image.seed};a.update('Image ready. Save changes to keep it.');
  })()`);
  await shot("appearance-768-image-derived");
  await viewport(390, 844, true);
  await shot("appearance-390-image-derived");
  await client.evaluate(`(() => { const a=document.querySelector('kin-app').appearance; a.choosePreset({id:'plum',name:'Plum',seed:'#74507D'}); })()`);
  await shot("appearance-390-manual-override-background");
  await client.evaluate(`(() => { const a=document.querySelector('kin-app').appearance; a.hex.value='#12';a.hex.dispatchEvent(new Event('input')); })()`);
  await shot("appearance-390-invalid-color");
  await client.evaluate(`document.querySelector('kin-app').ctx.session.lockHousehold(false)`);
  await delay(80);
  await shot("appearance-390-locked-cleared");
  await scheme("light");
  assert.deepEqual(problems, [], "Uncaught errors or console errors");
  console.log(`PASS screenshots written to ${outDir}`);
} finally {
  if (browserClient) await browserClient.send("Browser.close").catch(() => {});
  client?.close(); browserClient?.close();
  browser.kill();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
