import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Capture view at 400px (ADRs 0296 to 0298): photos, remembered picks and notes become one
// unpublished job draft; a dropped connection keeps the capture and sends it once; a voice note is bounded.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
let root;
let server;
let origin;

test.use({ viewport: { width: 400, height: 800 } });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-capture-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  execFileSync(binary, ["user", "add", "writer", "--root", root], {
    env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe",
  });
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--admin", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/admin/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  removeTree(root);
});

async function openCapture(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.goto(`${origin}/admin/#/capture`);
  await expect(page.locator("[data-job-capture]")).toBeVisible();
}

// No control or region is wider than the viewport (a small tolerance, never tuned to one platform's fonts).
async function expectNoOverflow(page, selector) {
  const wider = await page.locator(selector).evaluate((region) => {
    const limit = document.documentElement.clientWidth + 2;
    const offenders = [region, ...region.querySelectorAll("*")].filter((node) => node.getBoundingClientRect().right > limit);
    return offenders.map((node) => `${node.tagName}.${node.className}`);
  });
  expect(wider).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)).toBe(true);
}

const photo = (name) => ({ name, mimeType: "image/png", buffer: PNG });
const drafts = () => {
  const dir = join(root, "content", "posts");
  return readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}-(flooring|job|roofing)-.*-[0-9a-f]{6}\.md$/.test(name)).map((name) => join(dir, name));
};

test("three photos and notes become one unpublished job draft, and the picks are remembered", async ({ page }) => {
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  await expect(view.getByText("Add photos", { exact: true })).toBeVisible();
  for (const label of ["Trade", "Service", "Town", "Notes"]) await expect(view.getByLabel(label, { exact: true })).toBeVisible();
  for (const control of await view.locator("select, input[type=text], textarea, button, label.oba-btn").all()) {
    expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(43);
  }
  await expectNoOverflow(page, "[data-job-capture]");

  await view.getByLabel("Add photos", { exact: true }).setInputFiles([photo("front.png"), photo("a very long photo name from my phone camera roll 2026.png"), photo("rear.png")]);
  await expect(view.locator(".oba-capture-photo")).toHaveCount(3);
  await expectNoOverflow(page, "[data-job-capture]");
  await view.getByLabel("Trade", { exact: true }).selectOption("flooring");
  await view.getByLabel("Service", { exact: true }).fill("hardwood-install");
  await view.getByLabel("Town", { exact: true }).fill("Springfield");
  await view.getByLabel("Notes", { exact: true }).fill("Floor squeaked by the back door. Pulled two boards.");
  await view.getByRole("button", { name: "Save draft" }).click();
  await expect(view.locator("[data-capture-saved]")).toContainText("Saved as a draft");
  await expectNoOverflow(page, "[data-job-capture]");

  const [file] = drafts();
  const source = readFileSync(file, "utf8");
  expect(source).toMatch(/draft: "?true"?/);
  expect(source).toMatch(/profile: job/);
  expect(source).toContain("Floor squeaked by the back door.");
  expect(source.match(/!\[Photo \d from the job\]\(\/images\/uploads\//g)).toHaveLength(3);
  expect(source).toMatch(/Springfield/);

  await page.getByRole("link", { name: "Open it in Write" }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Flooring in Springfield");

  // The draft is listed with the other posts, and the picks come back on the next visit.
  await page.goto(`${origin}/admin/#/posts`);
  await expect(page.getByText("Flooring in Springfield").first()).toBeVisible();
  await page.goto(`${origin}/admin/#/capture`);
  const again = page.locator("[data-job-capture]");
  await expect(again.getByLabel("Trade", { exact: true })).toHaveValue("flooring");
  await expect(again.getByLabel("Service", { exact: true })).toHaveValue("hardwood-install");
  await expect(again.getByRole("group", { name: "Recent towns" }).getByRole("button", { name: "Springfield" })).toBeVisible();
  await again.getByRole("button", { name: "Springfield" }).click();
  await expect(again.getByLabel("Town", { exact: true })).toHaveValue("Springfield");
});

test("an empty capture is refused with a sentence and nothing is saved", async ({ page }) => {
  await openCapture(page);
  const before = drafts().length;
  await page.locator("[data-job-capture]").getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator("[data-capture-status]")).toContainText("Add a photo or a few words first.");
  expect(drafts().length).toBe(before);
});

const draftsIn = (town) => drafts().filter((file) => file.toLowerCase().includes(town));

async function fillCapture(view, town) {
  await view.getByLabel("Add photos", { exact: true }).setInputFiles([photo("one.png"), photo("two.png")]);
  await view.getByLabel("Trade", { exact: true }).selectOption("roofing");
  await view.getByLabel("Town", { exact: true }).fill(town);
  await view.getByLabel("Notes", { exact: true }).fill("Flashing lifted at the valley.");
}

test("offline, a capture is kept on the device and sends once when the connection returns", async ({ page, context }) => {
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  await fillCapture(view, "Offlinetown");
  await context.setOffline(true);
  await view.getByRole("button", { name: "Save draft" }).click();
  const pending = view.locator("[data-capture-pending-list]");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("Waiting for a connection.");
  await expect(view.locator("[data-capture-status]")).toContainText("kept on this device");
  await expect(view.getByLabel("Notes", { exact: true })).toHaveValue("");
  await expectNoOverflow(page, "[data-job-capture]");
  expect(draftsIn("offlinetown")).toHaveLength(0);

  await context.setOffline(false);
  await expect(view.locator("[data-capture-saved]")).toContainText("Saved as a draft");
  await expect(pending).toBeHidden();
  await expect.poll(() => draftsIn("offlinetown").length).toBe(1);
  const source = readFileSync(draftsIn("offlinetown")[0], "utf8");
  expect(source.match(/!\[Photo \d from the job\]\(\/images\/uploads\/captures\/capture-[0-9a-f]{12}-[01]\.png\)/g)).toHaveLength(2);
});

test("a kept capture survives a reload, sends on request without a second draft, and can be discarded", async ({ page }) => {
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  await page.route(/\/admin\/api\/(upload|document)/, (route) => route.abort("connectionrefused"));
  await fillCapture(view, "Reloadville");
  await view.getByRole("button", { name: "Save draft" }).click();
  const pending = view.locator("[data-capture-pending-list]");
  await expect(pending).toContainText("Waiting for a connection.");

  await page.reload();
  const again = page.locator("[data-job-capture]");
  await expect(again.locator("[data-capture-pending-list]")).toContainText("Waiting for a connection.");
  expect(draftsIn("reloadville")).toHaveLength(0);

  await page.unroute(/\/admin\/api\/(upload|document)/);
  await again.getByRole("button", { name: /^Send now/ }).click();
  await expect(again.locator("[data-capture-saved]")).toContainText("Saved as a draft");
  await expect.poll(() => draftsIn("reloadville").length).toBe(1);

  // Sending again after a reload finds nothing waiting and makes no second draft.
  await page.reload();
  await expect(page.locator("[data-job-capture]")).toBeVisible();
  await expect(page.locator("[data-capture-pending-list]")).toBeHidden();
  expect(draftsIn("reloadville")).toHaveLength(1);

  await page.route(/\/admin\/api\/(upload|document)/, (route) => route.abort("connectionrefused"));
  await fillCapture(page.locator("[data-job-capture]"), "Binton");
  await page.locator("[data-job-capture]").getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator("[data-capture-pending-list]")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^Discard/ }).click();
  await expect(page.locator("[data-capture-pending-list]")).toBeHidden();
});

// A stand-in for the browser's recorder and microphone, so the run is deterministic and needs no device.
const fakeMicrophone = ({ denied, supported }) => {
  window.__mic = { asked: 0, open: 0, stopped: 0 };
  navigator.mediaDevices.getUserMedia = async () => {
    window.__mic.asked += 1;
    if (denied) throw Object.assign(new Error(denied), { name: denied });
    window.__mic.open += 1;
    return { getTracks: () => [{ stop() { window.__mic.stopped += 1; } }] };
  };
  class FakeRecorder {
    static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
    constructor(stream, options) { this.mimeType = options?.mimeType || ""; this.state = "inactive"; this.slices = 0; }
    start() { this.state = "recording"; this.emit(); }
    emit() {
      const bytes = this.slices++ === 0 ? [0x1a, 0x45, 0xdf, 0xa3, ...new Array(300).fill(7)] : new Array(300).fill(7);
      this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: "audio/webm" }) });
    }
    stop() { this.state = "inactive"; this.emit(); setTimeout(() => this.onstop?.(), 0); }
  }
  if (supported) window.MediaRecorder = FakeRecorder;
  else delete window.MediaRecorder;
};

const voiceFiles = () => {
  const dir = join(root, ".openblog", "captures");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".audio.webm")) : [];
};

test("a voice note is recorded only after a tap, kept privately with the draft and never published", async ({ page }) => {
  await page.addInitScript(fakeMicrophone, { denied: "", supported: true });
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  const voice = view.locator("[data-capture-voice]");
  await expect(voice.getByRole("button", { name: "Record a voice note" })).toBeVisible();
  await expect(voice).toContainText("Up to 3 minutes");
  expect((await voice.getByRole("button", { name: "Record a voice note" }).boundingBox()).height).toBeGreaterThanOrEqual(43);

  // A script cannot start it: only a real tap can.
  await voice.getByRole("button", { name: "Record a voice note" }).evaluate((button) => button.click());
  await expect(view.locator("[data-capture-status]")).toContainText("only when you tap Record");
  expect(await page.evaluate(() => window.__mic.asked)).toBe(0);

  await voice.getByRole("button", { name: "Record a voice note" }).click();
  await expect(voice.locator("[data-capture-timer]")).toContainText("Recording 0:0");
  await expect(voice.getByRole("button", { name: "Stop recording" })).toBeVisible();
  await expect(voice.getByRole("button", { name: "Discard" })).toBeVisible();
  await expectNoOverflow(page, "[data-job-capture]");
  await voice.getByRole("button", { name: "Stop recording" }).click();
  await expect(voice.locator("audio")).toBeVisible();
  await expect(voice).toContainText("kept on your own server");
  expect(await page.evaluate(() => window.__mic)).toEqual({ asked: 1, open: 1, stopped: 1 });
  await expectNoOverflow(page, "[data-job-capture]");

  await view.getByLabel("Town", { exact: true }).fill("Voiceburg");
  const before = voiceFiles().length;
  await view.getByRole("button", { name: "Save draft" }).click();
  await expect(view.locator("[data-capture-saved]")).toContainText("voice note is kept privately");
  await expect.poll(() => voiceFiles().length).toBe(before + 1);
  await expect.poll(() => draftsIn("voiceburg").length).toBe(1);
  const source = readFileSync(draftsIn("voiceburg")[0], "utf8");
  expect(source).not.toMatch(/audio|webm/i);
  const files = voiceFiles();
  const ledger = readdirSync(join(root, ".openblog", "captures")).filter((name) => name.endsWith(".json"));
  expect(ledger.some((name) => readFileSync(join(root, ".openblog", "captures", name), "utf8").includes(".audio.webm"))).toBe(true);
  expect(files.every((name) => !existsSync(join(root, "static", name)) && !existsSync(join(root, "dist", name)))).toBe(true);
});

test("a recording can be stopped and discarded, and a discarded one is never sent", async ({ page }) => {
  await page.addInitScript(fakeMicrophone, { denied: "", supported: true });
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  const voice = view.locator("[data-capture-voice]");
  await voice.getByRole("button", { name: "Record a voice note" }).click();
  await voice.getByRole("button", { name: "Discard" }).click();
  await expect(view.locator("[data-capture-status]")).toContainText("Recording discarded");
  await expect(voice.getByRole("button", { name: "Record a voice note" })).toBeVisible();
  expect(await page.evaluate(() => window.__mic)).toEqual({ asked: 1, open: 1, stopped: 1 });

  await voice.getByRole("button", { name: "Record a voice note" }).click();
  await voice.getByRole("button", { name: "Stop recording" }).click();
  await voice.getByRole("button", { name: "Discard voice note" }).click();
  await expect(voice.locator("audio")).toHaveCount(0);
  await expect(voice.getByRole("button", { name: "Record a voice note" })).toBeFocused();
  const before = voiceFiles().length;
  await view.getByRole("button", { name: "Save draft" }).click();
  await expect(view.locator("[data-capture-status]")).toContainText("Add a photo or a few words first.");
  expect(voiceFiles().length).toBe(before);
});

test("a recording stops at the three minute limit by itself", async ({ page }) => {
  await page.addInitScript(fakeMicrophone, { denied: "", supported: true });
  await openCapture(page);
  await page.clock.install();
  const view = page.locator("[data-job-capture]");
  const voice = view.locator("[data-capture-voice]");
  await voice.getByRole("button", { name: "Record a voice note" }).click();
  await expect(voice.getByRole("button", { name: "Stop recording" })).toBeVisible();
  await page.clock.fastForward(181_000);
  await expect(voice.locator("audio")).toBeVisible();
  await expect(view.locator("[data-capture-status]")).toContainText("three minute limit");
  await expect(voice).toContainText("3:00");
  expect(await page.evaluate(() => window.__mic.stopped)).toBe(1);
});

test("without a recorder or with the microphone blocked, typing still works and nothing is left recording", async ({ page, browser }) => {
  const plain = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await plain.addInitScript(fakeMicrophone, { denied: "", supported: false });
  await openCapture(plain);
  const absent = plain.locator("[data-capture-voice]");
  await expect(absent).toContainText("cannot record audio");
  await expect(absent.getByRole("button")).toHaveCount(0);
  await expect(plain.locator("[data-job-capture]").getByLabel("Notes", { exact: true })).toBeVisible();
  await plain.close();

  await page.addInitScript(fakeMicrophone, { denied: "NotAllowedError", supported: true });
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  await view.getByRole("button", { name: "Record a voice note" }).click();
  await expect(view.locator("[data-capture-status]")).toContainText("microphone is blocked");
  await expect(view.getByRole("button", { name: "Record a voice note" })).toBeEnabled();
  expect(await page.evaluate(() => window.__mic.open)).toBe(0);
});

const TRANSCRIBE = /\/admin\/api\/assistant\/transcribe(\?.*)?$/;
const DISCLOSURE = {
  available: true, engine: "provider", provider: "open-ai", destination: "https://api.openai.com", model: "gpt-4o-mini-transcribe", leavesServer: true,
  sends: ["Your voice note (1 KB, webm). Nothing else: no notes, photos, title or voice guide."], keeps: "The transcript is kept privately on your server, beside the note.",
};

async function recordNote(page, voice) {
  await voice.getByRole("button", { name: "Record a voice note" }).click();
  await voice.getByRole("button", { name: "Stop recording" }).click();
  await expect(voice.locator("audio")).toBeVisible();
}

test("without a provider the voice note still works and typing is the way forward", async ({ page }) => {
  await page.addInitScript(fakeMicrophone, { denied: "", supported: true });
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  const voice = view.locator("[data-capture-voice]");
  await recordNote(page, voice);
  await expect(voice.locator("[data-capture-transcribe-off]")).toContainText("Type your notes instead");
  await expect(voice.getByRole("button", { name: "Transcribe with AI" })).toHaveCount(0);
  await expectNoOverflow(page, "[data-job-capture]");
  await view.getByLabel("Notes", { exact: true }).fill("Typed because there is no provider.");
  await view.getByLabel("Town", { exact: true }).fill("Typedtown");
  await view.getByRole("button", { name: "Save draft" }).click();
  await expect(view.locator("[data-capture-saved]")).toContainText("Saved as a draft");
  await expect.poll(() => draftsIn("typedtown").length).toBe(1);
});

test("transcription shows what is sent, waits for a confirmation, and adds an undoable transcript", async ({ page }) => {
  await page.addInitScript(fakeMicrophone, { denied: "", supported: true });
  const posts = [];
  await page.route(TRANSCRIBE, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: DISCLOSURE });
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: { transcript: "Replaced the valve. <img src=x onerror=alert(1)>", truncated: false, untrusted: true } });
  });
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  const voice = view.locator("[data-capture-voice]");
  await view.getByLabel("Notes", { exact: true }).fill("Typed first.");
  await recordNote(page, voice);
  const start = voice.getByRole("button", { name: "Transcribe with AI" });
  await expect(start).toBeVisible();
  expect((await start.boundingBox()).height).toBeGreaterThanOrEqual(43);
  await start.click();
  const disclosure = voice.locator("[data-capture-disclosure]");
  await expect(disclosure).toContainText("https://api.openai.com");
  await expect(disclosure).toContainText("Nothing else");
  await expect(disclosure).toContainText("leaves your server");
  await expectNoOverflow(page, "[data-job-capture]");
  await voice.getByRole("button", { name: "Cancel" }).click();
  expect(posts).toEqual([]);
  await expect(start).toBeFocused();

  await start.click();
  await voice.getByRole("button", { name: "Send the recording" }).click();
  const notes = view.getByLabel("Notes", { exact: true });
  await expect(notes).toHaveValue(/Typed first\.\n\nReplaced the valve\. &lt;img src=x onerror=alert\(1\)>/);
  expect(posts).toHaveLength(1);
  expect(posts[0].confirmed).toBe(true);
  await expect(view.locator("[data-capture-status]")).toContainText("written by a machine");
  await expectNoOverflow(page, "[data-job-capture]");
  await voice.getByRole("button", { name: "Undo the transcript" }).click();
  await expect(notes).toHaveValue("Typed first.");
  expect(await page.locator("[data-job-capture] img[src=x]").count()).toBe(0);
});
const ASSISTANT_STATUS = /\/admin\/api\/assistant\/status$/;
const JOB_DRAFT = /\/admin\/api\/assistant\/job-draft$/;
const AI_DRAFT = {
  title: "Water heater swap in Draftville",
  description: "Replaced a leaking tank heater in an afternoon.",
  sections: { problem: "The old tank was leaking at the drain.", found: "The drain valve had corroded through.", did: "I fitted a new 40 gallon tank.", result: "" },
};

test("without a provider the typed notes become the post and the flow completes", async ({ page }) => {
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  const notes = view.getByLabel("Notes", { exact: true });
  await expect(view.locator("[data-capture-draft]")).toContainText("Add a few words");
  await notes.fill("Typed notes with no provider at all.");
  await expect(view.locator("[data-capture-draft-off]")).toContainText("not set up on this site");
  await expect(view.getByRole("button", { name: "Draft with AI" })).toHaveCount(0);
  await expectNoOverflow(page, "[data-job-capture]");
  await view.getByLabel("Town", { exact: true }).fill("Plaintown");
  await view.getByRole("button", { name: "Save draft" }).click();
  await expect(view.locator("[data-capture-saved]")).toContainText("Saved as a draft");
  await expect.poll(() => draftsIn("plaintown").length).toBe(1);
  expect(readFileSync(draftsIn("plaintown")[0], "utf8")).toContain("Typed notes with no provider at all.");
});

test("Draft with AI shows what is sent, fills unsaved editable fields, undoes in one step and never saves by itself", async ({ page }) => {
  const guide = join(root, ".openblog", "private", "context", "voice.md");
  mkdirSync(dirname(guide), { recursive: true });
  writeFileSync(guide, "# Voice guide\n\nShort plain sentences. Says tank, never unit.\n");
  const sent = [];
  await page.route(ASSISTANT_STATUS, (route) => route.fulfill({ json: { providerType: "open-ai", model: "test-model", destination: "https://api.openai.com", configured: true, state: "ready", message: "ready" } }));
  await page.route(JOB_DRAFT, (route) => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: { draft: AI_DRAFT, body: "", proposal: true } }); });
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  const box = view.locator("[data-capture-draft]");
  const documentSaves = [];
  page.on("request", (request) => { if (request.method() === "POST" && /\/admin\/api\/document$/.test(request.url())) documentSaves.push(request.url()); });

  await view.getByLabel("Town", { exact: true }).fill("Draftville");
  await view.getByLabel("Notes", { exact: true }).fill("swapped a heater, old one leaked at the drain. valve corroded.");
  const start = box.getByRole("button", { name: "Draft with AI" });
  await expect(start).toBeEnabled();
  expect((await start.boundingBox()).height).toBeGreaterThanOrEqual(43);
  await start.click();
  const disclosure = box.locator("[data-capture-draft-disclosure]");
  await expect(disclosure).toContainText("https://api.openai.com (test-model)");
  await expect(disclosure).toContainText("your private voice guide");
  await expect(disclosure).toContainText("never sent with a draft");
  await expectNoOverflow(page, "[data-job-capture]");
  await box.getByRole("button", { name: "Cancel" }).click();
  expect(sent).toEqual([]);
  await expect(start).toBeFocused();

  await start.click();
  await box.getByRole("button", { name: "Send to the Assistant" }).click();
  await expect(box.getByLabel("Title", { exact: true })).toHaveValue("Water heater swap in Draftville");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ town: "Draftville", contextIds: ["private:voice"] });
  expect(sent[0].notes).toContain("valve corroded");
  await expect(box).toContainText("not saved yet");
  await expect(box.getByLabel("What we did", { exact: true })).toHaveValue("I fitted a new 40 gallon tank.");
  await expectNoOverflow(page, "[data-job-capture]");
  for (const control of await box.locator("input, textarea, button").all()) {
    expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(43);
  }
  expect(documentSaves).toEqual([]);

  // One undo takes it all back; the notes were never touched.
  await box.getByRole("button", { name: "Undo the draft" }).click();
  await expect(box.getByLabel("Title", { exact: true })).toHaveCount(0);
  await expect(view.getByLabel("Notes", { exact: true })).toHaveValue(/valve corroded/);
  expect(documentSaves).toEqual([]);

  // Draft again, edit it, then save normally: only now does anything reach the server.
  await start.click();
  await box.getByRole("button", { name: "Send to the Assistant" }).click();
  await box.getByLabel("Result", { exact: true }).fill("Hot water by dinner.");
  await box.getByLabel("Title", { exact: true }).fill("Water heater swap, Draftville");
  expect(documentSaves).toEqual([]);
  await view.getByRole("button", { name: "Save draft" }).click();
  await expect(view.locator("[data-capture-saved]")).toContainText("Saved as a draft");
  expect(documentSaves).toHaveLength(1);
  const titled = () => readdirSync(join(root, "content", "posts")).filter((name) => name.includes("draftville")).map((name) => join(root, "content", "posts", name));
  await expect.poll(() => titled().length).toBe(1);
  const source = readFileSync(titled()[0], "utf8");
  expect(source).toMatch(/draft: "?true"?/);
  expect(source).toMatch(/profile: job/);
  expect(source).toContain("Water heater swap, Draftville");
  expect(source).toContain("Replaced a leaking tank heater in an afternoon.");
  expect(source).toMatch(/## Problem\n\nThe old tank was leaking at the drain\.\n\n## What we found/);
  expect(source).toContain("Hot water by dinner.");
  expect(source).not.toContain("valve corroded");
  await expect(box.getByLabel("Title", { exact: true })).toHaveCount(0);
  await expectNoOverflow(page, "[data-job-capture]");
});

test("a refused draft says why and leaves the notes and the save untouched", async ({ page }) => {
  await page.route(ASSISTANT_STATUS, (route) => route.fulfill({ json: { destination: "https://api.openai.com", model: "m", configured: true, state: "ready", message: "ready" } }));
  await page.route(JOB_DRAFT, (route) => route.fulfill({ status: 502, json: { error: "The provider's job draft was rejected because it contained HTML. Nothing was applied.", code: "invalid-result" } }));
  await openCapture(page);
  const view = page.locator("[data-job-capture]");
  const box = view.locator("[data-capture-draft]");
  await view.getByLabel("Notes", { exact: true }).fill("some notes");
  await box.getByRole("button", { name: "Draft with AI" }).click();
  await box.getByRole("button", { name: "Send to the Assistant" }).click();
  await expect(view.locator("[data-capture-status]")).toContainText("Nothing was applied");
  await expect(box.getByLabel("Title", { exact: true })).toHaveCount(0);
  await expect(view.getByLabel("Notes", { exact: true })).toHaveValue("some notes");
  await expect(box.getByRole("button", { name: "Draft with AI" })).toBeEnabled();
  await expectNoOverflow(page, "[data-job-capture]");
});