// The outbound HTTP transport for ACME and the CT check (#724, #727).
//
// A transport is any function `(url, { method, headers, body }) =>
// Promise<{ status, headers: { get(name) }, text() }>`, which is the subset of
// `fetch` the client uses, so tests (and anything else) can inject their own.
// This default one is `node:https` with a time limit and a size cap. Plain
// `http:` is refused unless `allowLoopbackHttp` is set and the host is a
// loopback address: that exists for local test servers, never for Let's
// Encrypt.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function createHttpsTransport({ timeoutMs = 30_000, maxBytes = 4 * 1024 * 1024, allowLoopbackHttp = false, userAgent = "kin-home-acme/1" } = {}) {
  return function transport(target, { method = "GET", headers = {}, body } = {}) {
    const url = new URL(target);
    const plain = url.protocol === "http:";
    if (!(url.protocol === "https:" || (plain && allowLoopbackHttp && LOOPBACK.has(url.hostname)))) {
      return Promise.reject(Object.assign(new Error("only https URLs are allowed"), { code: "acme-insecure-url" }));
    }
    const payload = body === undefined ? undefined : Buffer.from(body);
    return new Promise((resolve, reject) => {
      const request = (plain ? httpRequest : httpsRequest)(url, {
        method,
        headers: { "user-agent": userAgent, ...headers, ...(payload ? { "content-length": payload.length } : {}) },
        timeout: timeoutMs,
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { response.destroy(); reject(Object.assign(new Error("response too large"), { code: "acme-response-too-large" })); return; }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            headers: { get: (name) => { const value = response.headers[String(name).toLowerCase()]; return Array.isArray(value) ? value.join(", ") : value ?? null; } },
            text: async () => bytes.toString("utf8"),
            json: async () => JSON.parse(bytes.toString("utf8")),
          });
        });
      });
      request.on("timeout", () => request.destroy(Object.assign(new Error("request timed out"), { code: "acme-timeout" })));
      request.on("error", reject);
      request.end(payload);
    });
  };
}
