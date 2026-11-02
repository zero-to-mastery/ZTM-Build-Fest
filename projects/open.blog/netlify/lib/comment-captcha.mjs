import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const DEFAULT_TTL_SECONDS = 1800;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86400;
const VERIFY_TIMEOUT_MS = 5000;

// Reads the operator's environment once. `missing` names variables, never values.
export function captchaSettings(env) {
  const provider = String(env.OPENBLOG_CAPTCHA_PROVIDER || "off").trim().toLowerCase() || "off";
  const scope = String(env.OPENBLOG_CAPTCHA_SCOPE || "session").trim().toLowerCase() || "session";
  const ttlValue = Number.parseInt(String(env.OPENBLOG_CAPTCHA_SESSION_TTL_SECONDS || ""), 10);
  const ttl = Number.isFinite(ttlValue) ? Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, ttlValue)) : DEFAULT_TTL_SECONDS;
  const turnstileSecret = String(env.OPENBLOG_TURNSTILE_SECRET || "");
  const sessionSecret = String(env.OPENBLOG_CAPTCHA_SESSION_SECRET || "");
  const missing = [];
  if (provider !== "off" && provider !== "turnstile") missing.push("OPENBLOG_CAPTCHA_PROVIDER");
  else if (provider === "turnstile") {
    if (!turnstileSecret) missing.push("OPENBLOG_TURNSTILE_SECRET");
    if (scope !== "session" && scope !== "every-comment") missing.push("OPENBLOG_CAPTCHA_SCOPE");
    else if (scope === "session" && sessionSecret.length < 32) missing.push("OPENBLOG_CAPTCHA_SESSION_SECRET");
  }
  return { provider, scope, ttl, turnstileSecret, sessionSecret, missing, enabled: provider !== "off" };
}

const signature = (payload, secret) => createHmac("sha256", secret).update(payload).digest("base64url");

// A pass is base64url({ s: site, e: expiry seconds, n: nonce }) + "." + HMAC-SHA256. Nothing is stored.
export function issuePass(site, secret, now, ttl = DEFAULT_TTL_SECONDS) {
  const expiresAt = Math.floor(now.getTime() / 1000) + ttl;
  const payload = Buffer.from(JSON.stringify({ s: site, e: expiresAt, n: randomBytes(16).toString("hex") })).toString("base64url");
  return { pass: `${payload}.${signature(payload, secret)}`, expiresAt };
}

// { ok } or { ok: false, reason: "malformed" | "forged" | "other_site" | "expired" }.
export function checkPass(pass, site, secret, now) {
  if (typeof pass !== "string" || pass.length > 2048) return { ok: false, reason: "malformed" };
  const parts = pass.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(signature(parts[0], secret));
  const supplied = Buffer.from(parts[1]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return { ok: false, reason: "forged" };
  let value;
  try {
    value = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!value || typeof value.n !== "string" || !Number.isInteger(value.e) || typeof value.s !== "string") return { ok: false, reason: "malformed" };
  if (value.s !== site) return { ok: false, reason: "other_site" };
  const seconds = Math.floor(now.getTime() / 1000);
  if (value.e <= seconds) return { ok: false, reason: "expired" };
  if (value.e > seconds + MAX_TTL_SECONDS) return { ok: false, reason: "malformed" };
  return { ok: true };
}

const PROVIDER_REASONS = [
  ["timeout-or-duplicate", "reused"],
  ["invalid-input-response", "invalid"],
  ["missing-input-response", "invalid"],
  ["expired", "expired"],
  ["invalid-input-secret", "misconfigured"],
  ["missing-input-secret", "misconfigured"],
];

// Provider seam. Resolves { ok: true } or { ok: false, reason }; reasons are:
// missing_token, invalid, reused, expired, misconfigured, rejected, network, timeout, provider_error.
// It never throws, and never returns or logs the token, the secret or provider text.
export async function verifyCaptcha({ provider, token, secret, remoteIp, fetchImpl, timeoutMs = VERIFY_TIMEOUT_MS }) {
  if (provider !== "turnstile") return { ok: false, reason: "misconfigured" };
  if (typeof token !== "string" || !token || token.length > 2048) return { ok: false, reason: "missing_token" };
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);
  let response;
  try {
    response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network" };
  }
  let result;
  try {
    if (!response.ok) return { ok: false, reason: "provider_error" };
    result = await response.json();
  } catch {
    return { ok: false, reason: "provider_error" };
  }
  if (!result || typeof result !== "object" || typeof result.success !== "boolean") return { ok: false, reason: "provider_error" };
  if (result.success) return { ok: true };
  const codes = Array.isArray(result["error-codes"]) ? result["error-codes"].map(String) : [];
  for (const [code, reason] of PROVIDER_REASONS) if (codes.some((value) => value.includes(code))) return { ok: false, reason };
  return { ok: false, reason: "rejected" };
}
