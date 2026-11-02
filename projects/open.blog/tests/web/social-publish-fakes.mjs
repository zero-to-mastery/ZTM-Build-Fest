// A scripted provider for the social publishing adapter tests. It records every request and
// answers from a fixed reply, so no test that uses it can reach a real network.
import { socialProviders } from "../../netlify/lib/social-providers.mjs";
import { DeliveryError } from "../../netlify/lib/social-delivery.mjs";
import { env } from "./social-oauth-fakes.mjs";

export const LI_TOKEN = "AQX-publish-access-token-0001";
export const PAGE_TOKEN = "EAApage-publish-token-0002";
export const providers = (overrides) => socialProviders(env(overrides));

// A reply is { status, headers, body }, an Error to throw, or a function of (call number, url, init).
export function scripted(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body, redirect: init.redirect, signal: init.signal, hasSignal: Boolean(init.signal) });
    const next = typeof reply === "function" ? await reply(calls.length, String(url), init) : reply;
    if (next instanceof Error) throw next;
    const body = next.body === undefined ? null : typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status, headers: next.headers });
  };
  return { fetchImpl, calls };
}

// The failures a fetch can throw, the way Node's fetch throws them.
export const networkFailure = (kind, secret = "") => {
  if (kind === "refused") return new TypeError(`fetch failed ${secret}`, { cause: Object.assign(new Error(`connect ECONNREFUSED ${secret}`), { code: "ECONNREFUSED" }) });
  if (kind === "timeout") return new DOMException(`The operation timed out ${secret}`, "TimeoutError");
  if (kind === "abort") return new DOMException(`This operation was aborted ${secret}`, "AbortError");
  return new TypeError(`fetch failed ${secret}`, { cause: Object.assign(new Error(`socket hang up ${secret}`), { code: "ECONNRESET" }) });
};

// What the worker hands an adapter (social-worker.mjs `view`), for one provider.
export const ACCOUNTS = {
  linkedin: { provider: "linkedin", kind: "member", externalId: "urn:li:person:abc123", displayName: "Ada" },
  facebook: { provider: "facebook", kind: "page", externalId: "10987654321", displayName: "Lantern Page" },
};

export const call = (provider = "linkedin", { post = {}, account = {}, accessToken, signal } = {}) => ({
  post: { id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", idempotencyKey: "idem-key-0001", caption: "A new post is up.", canonicalUrl: "https://blog.example.com/posts/hello/", work: "/posts/hello/", ...post },
  account: { ...ACCOUNTS[provider], ...account },
  accessToken: accessToken === undefined ? (provider === "facebook" ? PAGE_TOKEN : LI_TOKEN) : accessToken,
  signal: signal === undefined ? AbortSignal.timeout(5000) : signal,
});

// Runs `promise` and returns { value } or { error }, so a test can assert either.
export async function settle(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

export const isDelivery = (error, kind) => error instanceof DeliveryError && error.kind === kind;
