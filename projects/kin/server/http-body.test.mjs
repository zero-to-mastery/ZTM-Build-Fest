// Request bodies are refused at their byte limit while they stream.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { readBody, readJsonBody } from "./http-body.mjs";
import { PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { DurableStore } from "./durable-store.mjs";
import { encodeEnvelopeBatch, MAX_CIPHERTEXT_BYTES, RECORD_FIXED } from "../web/sync/envelope-wire.js";
import { MAX_EVENTS_PER_BATCH } from "./sync-service.mjs";

const LIMIT = 1_000;

// A server that reads each body with readBody and reports what it buffered.
async function bodyServer() {
  const seen = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request, response, LIMIT);
      seen.push(body.length);
      response.end(`ok ${body.length}`);
    } catch (error) {
      seen.push(error.code);
      response.writeHead(error.status ?? 500).end(error.code);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Sends `headers`, then writes `chunk` repeatedly (at most `count` times)
// until the server answers; resolves with the status, body and bytes sent.
function send(port, { path = "/", headers = {}, chunk = Buffer.alloc(0), count = 0, end = true }) {
  return new Promise((resolve, reject) => {
    let sent = 0;
    let answered = false;
    const request = httpRequest({ port, host: "127.0.0.1", method: "POST", path, headers }, (response) => {
      answered = true;
      let text = "";
      response.on("data", (data) => { text += data; });
      response.on("end", () => resolve({ status: response.statusCode, text, sent, connection: response.headers.connection }));
    });
    // A server that refuses mid-upload closes the connection; the client may
    // see that reset before it reads the 413.
    request.on("error", (error) => (answered ? undefined : resolve({ reset: error.code, sent })));
    request.flushHeaders();
    const pump = () => {
      while (!answered && sent < count * chunk.length) {
        sent += chunk.length;
        if (!request.write(chunk)) { request.once("drain", pump); return; }
      }
      if (end && !answered) request.end();
    };
    pump();
  });
}

test("a body within the limit is read whole", async () => {
  const server = await bodyServer();
  try {
    const exact = await send(server.port, { chunk: Buffer.alloc(100), count: 10 });
    assert.equal(exact.text, `ok ${LIMIT}`);
    const empty = await send(server.port, {});
    assert.equal(empty.text, "ok 0");
  } finally { await server.close(); }
});

test("a declared length over the limit is refused before the body is sent", async () => {
  const server = await bodyServer();
  try {
    // No body byte is ever written: a reader that waited for it would hang.
    const result = await send(server.port, { headers: { "Content-Length": String(LIMIT + 1) }, end: false });
    assert.equal(result.status, 413);
    assert.equal(result.connection, "close");
    assert.deepEqual(server.seen, ["request_too_large"]);
  } finally { await server.close(); }
});

test("a chunked body is refused as soon as it passes the limit", async () => {
  const server = await bodyServer();
  try {
    // Up to 64 MB offered; the server refuses after about 1 KB.
    const result = await send(server.port, { headers: { "Transfer-Encoding": "chunked" }, chunk: Buffer.alloc(256), count: 256 * 1024 });
    assert.deepEqual(server.seen, ["request_too_large"]);
    // Windows may surface an intentionally canceled pending write as
    // ECANCELED instead of the equivalent connection-reset/broken-pipe codes.
    const expectedReset = ["ECONNRESET", "EPIPE"].includes(result.reset) ||
      (process.platform === "win32" && result.reset === "ECANCELED");
    assert.ok(result.status === 413 || expectedReset, JSON.stringify(result));
    assert.ok(result.sent < 64 * 1024 * 1024, "the upload was cut short");
  } finally { await server.close(); }
});

test("JSON bodies parse, and malformed JSON is a bad request", async () => {
  const server = createServer(async (request, response) => {
    try { response.end(JSON.stringify(await readJsonBody(request, response, LIMIT))); }
    catch (error) { response.writeHead(error.status ?? 500).end(error.code); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.equal((await send(port, { chunk: Buffer.from('{"a":1}'), count: 1 })).text, '{"a":1}');
    assert.equal((await send(port, {})).text, "{}");
    const bad = await send(port, { chunk: Buffer.from("{"), count: 1 });
    assert.deepEqual([bad.status, bad.text], [400, "invalid_request"]);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("the Kin server answers an oversized API body with 413", async () => {
  const app = createKinServer({ service: new PairingService(), store: new DurableStore(":memory:") });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await send(app.server.address().port, {
      path: "/api/sync/enable",
      headers: { "Content-Length": String(300_000), "Content-Type": "application/json" }, end: false,
    });
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.text).error, "request_too_large");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store?.close();
  }
});

test("sync events must arrive as a well-formed binary batch", async () => {
  const app = createKinServer({ service: new PairingService(), store: new DurableStore(":memory:") });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${app.server.address().port}/api/sync/events`;
  try {
    const asJson = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"events":[]}' });
    assert.deepEqual([asJson.status, (await asJson.json()).error], [415, "unsupported_media_type"]);
    const wrongPrefix = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream-not-kin" }, body: encodeEnvelopeBatch([]) });
    assert.deepEqual([wrongPrefix.status, (await wrongPrefix.json()).error], [415, "unsupported_media_type"]);
    const malformed = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array([1, 2, 3]) });
    assert.deepEqual([malformed.status, (await malformed.json()).error], [400, "sync_batch_invalid"]);
    // A well-formed batch reaches authorization.
    const empty = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: encodeEnvelopeBatch([]) });
    assert.equal(empty.status, 401);
    const parameterized = await fetch(url, { method: "POST", headers: { "Content-Type": "Application/Octet-Stream; charset=binary" }, body: encodeEnvelopeBatch([]) });
    assert.equal(parameterized.status, 401);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store?.close();
  }
});

test("binary sync pushes enforce count and exact wire byte limits before authorization", async () => {
  const app = createKinServer({ service: new PairingService(), store: new DurableStore(":memory:") });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  const url = `http://127.0.0.1:${port}/api/sync/events`;
  const headers = { "Content-Type": "application/octet-stream" };
  const envelope = {
    protocolVersion: 1, envelopeVersion: 1,
    eventId: "ab".repeat(16), householdId: "cd".repeat(16), deviceId: "ef".repeat(16),
    deviceSequence: 1, logicalTime: "1", keyEpoch: 1,
    nonce: Buffer.alloc(12).toString("base64url"),
    signature: Buffer.alloc(64).toString("base64url"),
    ciphertext: Buffer.alloc(16).toString("base64url"),
  };
  const cap = 8 + MAX_EVENTS_PER_BATCH * (RECORD_FIXED + MAX_CIPHERTEXT_BYTES);
  try {
    const tooMany = await fetch(url, { method: "POST", headers, body: encodeEnvelopeBatch(Array(21).fill(envelope)) });
    assert.deepEqual([tooMany.status, (await tooMany.json()).error], [400, "sync_batch_invalid"]);
    const maximum = encodeEnvelopeBatch(Array(MAX_EVENTS_PER_BATCH).fill({
      ...envelope, ciphertext: Buffer.alloc(MAX_CIPHERTEXT_BYTES).toString("base64url"),
    }));
    assert.equal(maximum.length, 125_848);
    assert.equal(maximum.length, cap);
    const boundary = await fetch(url, { method: "POST", headers, body: maximum });
    assert.equal(boundary.status, 401, "the largest valid batch reaches authorization");
    const oversized = await fetch(url, { method: "POST", headers, body: new Uint8Array(cap + 1) });
    assert.deepEqual([oversized.status, (await oversized.json()).error], [413, "request_too_large"]);
    const declared = await send(port, {
      path: "/api/sync/events", headers: { ...headers, "Content-Length": String(cap + 1) }, end: false,
    });
    assert.deepEqual([declared.status, JSON.parse(declared.text).error], [413, "request_too_large"]);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store?.close();
  }
});
