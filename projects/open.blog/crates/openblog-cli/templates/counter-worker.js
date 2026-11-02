// open.blog view counter for Cloudflare Workers.
//
// The same privacy model as `openblog serve`: no cookies, no addresses stored,
// unique visitors counted with a daily hash that is never written anywhere.
// Written by `openblog analytics worker`. Deploy with Wrangler:
//
//   npm install --global wrangler       (one time)
//   wrangler kv namespace create VIEWS   (one time; put the id in wrangler.toml)
//   wrangler secret put EXPORT_SECRET    (one time; any long random string)
//   wrangler deploy
//
// Then set "analytics": { "endpoint": "https://<name>.<you>.workers.dev" } in
// openblog.json, and pull the data into your blog with
//   openblog analytics pull https://<name>.<you>.workers.dev --secret <EXPORT_SECRET>
//
// Routes: POST /hit {path, referrer}, GET /views?path=, GET /export (Bearer secret).

const MAX_HITS_PER_MINUTE = 30;
// Site paths only: lowercase slug segments that cannot start with a dot (no `..`).
const ALLOWED_PATH = /^\/(?:[a-z0-9_-][a-z0-9._-]*\/)*$/;

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function corsHeaders(origin, env) {
  const allowed = (env.SITE_ORIGIN || "*").split(",").map((s) => s.trim());
  const ok = allowed.includes("*") || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : allowed[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function referrerHost(referrer, ownOrigin) {
  try {
    const url = new URL(referrer);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (ownOrigin && new URL(ownOrigin).hostname.replace(/^www\./, "") === host) return null;
    return host.slice(0, 100);
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/views" && request.method === "GET") {
      const path = url.searchParams.get("path") || "";
      if (!ALLOWED_PATH.test(path)) return json({ error: "bad path" }, 400, cors);
      const views = Number((await env.VIEWS.get(`total:${path}`)) || 0);
      return json({ views }, 200, cors);
    }

    if (url.pathname === "/hit" && request.method === "POST") {
      if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return json({ error: "json only" }, 415, cors);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json" }, 400, cors);
      }
      const path = typeof body.path === "string" ? body.path : "";
      if (!ALLOWED_PATH.test(path) || path.length > 200) return json({ error: "bad path" }, 400, cors);
      const total = Number((await env.VIEWS.get(`total:${path}`)) || 0);
      const dnt = request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1";
      if (dnt) return json({ views: total, counted: false }, 200, cors);

      const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
      const minute = Math.floor(Date.now() / 60000);
      const rateKey = `rate:${await sha256(`${ip}|${minute}`)}`;
      const rate = Number((await env.VIEWS.get(rateKey)) || 0) + 1;
      await env.VIEWS.put(rateKey, String(rate), { expirationTtl: 120 });
      if (rate > MAX_HITS_PER_MINUTE) return json({ error: "too many hits" }, 429, cors);

      const day = today();
      // Daily salt: random, kept only for the day, so hashes cannot be linked across days.
      let salt = await env.VIEWS.get(`salt:${day}`);
      if (!salt) {
        salt = crypto.randomUUID();
        await env.VIEWS.put(`salt:${day}`, salt, { expirationTtl: 2 * 86400 });
      }
      const fingerprint = await sha256(`${salt}|${ip}|${request.headers.get("User-Agent") || ""}|${path}`);
      const seenKey = `seen:${day}:${fingerprint}`;
      const unique = !(await env.VIEWS.get(seenKey));
      if (unique) await env.VIEWS.put(seenKey, "1", { expirationTtl: 2 * 86400 });

      const dayKey = `day:${day}`;
      const stats = JSON.parse((await env.VIEWS.get(dayKey)) || '{"views":{},"uniques":{},"referrers":{}}');
      stats.views[path] = (stats.views[path] || 0) + 1;
      if (unique) stats.uniques[path] = (stats.uniques[path] || 0) + 1;
      const host = referrerHost(typeof body.referrer === "string" ? body.referrer : "", env.SITE_ORIGIN);
      if (host) stats.referrers[host] = (stats.referrers[host] || 0) + 1;
      await env.VIEWS.put(dayKey, JSON.stringify(stats));
      await env.VIEWS.put(`total:${path}`, String(total + 1));
      return json({ views: total + 1 }, 200, cors);
    }

    if (url.pathname === "/export" && request.method === "GET") {
      const auth = request.headers.get("Authorization") || "";
      if (!env.EXPORT_SECRET || auth !== `Bearer ${env.EXPORT_SECRET}`) return json({ error: "unauthorized" }, 401, {});
      const days = {};
      const totals = {};
      let cursor;
      do {
        const page = await env.VIEWS.list({ cursor, limit: 1000 });
        for (const key of page.keys) {
          if (key.name.startsWith("day:")) days[key.name.slice(4)] = JSON.parse((await env.VIEWS.get(key.name)) || "{}");
          else if (key.name.startsWith("total:")) totals[key.name.slice(6)] = Number((await env.VIEWS.get(key.name)) || 0);
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return json({ version: 1, days, totals }, 200, {});
    }

    return json({ error: "not found" }, 404, cors);
  },
};
