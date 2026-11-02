// The scheduled delivery worker of optional social publishing (epic #353, story #357, ADR 0317).
// Called on a schedule by pg_cron through pg_net (supabase/social-cron.sql), or by hand, with
// `POST` and `Authorization: Bearer <OPENBLOG_SOCIAL_WORKER_KEY>`. It runs one bounded batch of
// social-worker.mjs and answers with counts only.
//
// Who may call: only the worker key. The admin key is refused (403), a missing or wrong key is 401,
// and the public anon or publishable key can never match (socialSettings refuses a worker key that
// equals any other credential). Off unless OPENBLOG_SOCIAL_ENABLED=true and every setting is valid:
// then every request is a 404 and nothing touches Supabase or a provider. The route is
// /api/social-worker (netlify.toml). Set the function's timeout above OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS.

import { SocialScopeError, authorizeSocial, refuseClientScope, socialSettings } from "../lib/social-scope.mjs";
import { SocialCredentialError } from "../lib/social-credentials.mjs";
import { QueueError } from "../lib/social-queue.mjs";
import { socialProviders } from "../lib/social-providers.mjs";
import { socialAdapters } from "../lib/social-adapters.mjs";
import { deliveryPolicy } from "../lib/social-delivery.mjs";
import { createWorker } from "../lib/social-worker.mjs";

const MAX_BODY_CHARS = 1024;

const SECURITY = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
const json = (statusCode, value, extra = {}) => ({ statusCode, headers: { ...SECURITY, ...extra, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(value) });
const failure = (statusCode, code, message, extra) => json(statusCode, { error: code, message }, extra);

export function createHandler({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), random, adapters } = {}) {
  return async (event) => {
    try {
      const settings = socialSettings(env);
      if (!settings.enabled) return failure(404, "not-enabled", "Social publishing is not enabled.");
      const method = String(event.httpMethod || "GET").toUpperCase();
      if (method !== "POST") return failure(405, "method-not-allowed", "Use POST.", { allow: "POST" });
      // Worker key only. Checked before the body is read, so an unauthorized caller costs nothing.
      await authorizeSocial(event.headers, settings, { allow: ["worker"] });
      const raw = event.isBase64Encoded ? Buffer.from(String(event.body || ""), "base64").toString("utf8") : String(event.body || "");
      if (raw.length > MAX_BODY_CHARS) return failure(413, "too-large", "The request is too large.");
      let body = {};
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          return failure(400, "invalid-request", "The request is not valid JSON.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return failure(400, "invalid-request", "The request must be a JSON object.");
        if (Object.keys(body).length) return failure(400, "invalid-request", "The request takes no fields.");
      }
      const query = new URLSearchParams(typeof event.rawQuery === "string" ? event.rawQuery : event.queryStringParameters || {});
      refuseClientScope({ query, body });
      const providers = socialProviders(env);
      const worker = createWorker({
        settings,
        providers,
        adapters: adapters || socialAdapters({ providers, fetchImpl, now, env }),
        fetchImpl,
        now,
        random,
        policy: deliveryPolicy(env),
      });
      return json(200, { ok: true, summary: await worker.run() });
    } catch (error) {
      if (error instanceof SocialScopeError) return failure(error.status, error.code, error.message);
      if (error instanceof QueueError || error instanceof SocialCredentialError) return failure(503, "storage-unavailable", "The queue could not be reached.");
      // Nothing is logged with the error: it could carry a request, and a request carries credentials.
      return failure(500, "internal", "Something went wrong.");
    }
  };
}

export const handler = createHandler();
