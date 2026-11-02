// open.blog view counter as a small web service (Node + MongoDB), for Render or
// any host that runs Node. Written by `openblog analytics service`.
//
// Same contract as the built-in counter and the Cloudflare Worker:
//   POST /hit            {path, referrer}   -> {views}
//   GET  /views?path=    -> {views}
//   GET  /export         Authorization: Bearer <EXPORT_SECRET> -> {version, days, totals}
//
// Same privacy model: no cookies, no addresses or browser strings stored.
// Unique visitors come from a hash of a random daily salt, the address, the
// browser string and the page; the salt expires after two days, so hashes
// cannot be linked across days or to a person.
//
// Environment: MONGODB_URI, EXPORT_SECRET, SITE_ORIGIN (your blog's address;
// several comma-separated, or "*"), PORT (Render sets it).
//
// Only `mongodb` is a dependency; the HTTP server is Node's own.

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const MAX_HITS_PER_MINUTE = 30;
const ALLOWED_PATH = /^\/(?:[a-z0-9_-][a-z0-9._-]*\/)*$/;
const DAY_MS = 86_400_000;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);

function referrerHost(referrer, ownOrigins) {
  try {
    const url = new URL(referrer);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    for (const own of ownOrigins) {
      try {
        if (new URL(own).hostname.replace(/^www\./, "") === host) return null;
      } catch {
        // SITE_ORIGIN may be "*"
      }
    }
    return host.slice(0, 100);
  } catch {
    return null;
  }
}

/** Build the request handler around a MongoDB `Db` (or anything with the same collection API). */
export function createApp(db, env = process.env) {
  const origins = (env.SITE_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const hits = db.collection("hits"); // _id: `${day}|${path}`, day, path, views, uniques
  const referrers = db.collection("referrers"); // _id: `${day}|${host}`, day, host, count
  const totals = db.collection("totals"); // _id: path, views
  const seen = db.collection("seen"); // _id: `${day}|${fingerprint}`, expiresAt
  const salts = db.collection("salts"); // _id: day, salt, expiresAt
  const rate = db.collection("rate"); // _id: `${ipHash}|${minute}`, count, expiresAt

  async function ensureIndexes() {
    for (const c of [seen, salts, rate]) {
      await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }
  }

  function cors(origin) {
    const ok = origins.includes("*") || origins.includes(origin);
    return {
      "Access-Control-Allow-Origin": ok ? origin || "*" : origins[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  const send = (res, status, data, headers) => {
    res.writeHead(status, headers);
    res.end(data === null ? "" : JSON.stringify(data));
  };

  async function readJson(req, limit = 2048) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error("too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          reject(new Error("bad json"));
        }
      });
      req.on("error", reject);
    });
  }

  async function dailySalt(day) {
    const existing = await salts.findOne({ _id: day });
    if (existing) return existing.salt;
    const salt = randomUUID();
    await salts.updateOne({ _id: day }, { $setOnInsert: { salt, expiresAt: new Date(Date.now() + 2 * DAY_MS) } }, { upsert: true });
    return (await salts.findOne({ _id: day })).salt;
  }

  async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const origin = req.headers.origin || "";
    const headers = cors(origin);
    try {
      if (req.method === "OPTIONS") return send(res, 204, null, headers);

      if (url.pathname === "/views" && req.method === "GET") {
        const path = url.searchParams.get("path") || "";
        if (!ALLOWED_PATH.test(path)) return send(res, 400, { error: "bad path" }, headers);
        const t = await totals.findOne({ _id: path });
        return send(res, 200, { views: t ? t.views : 0 }, headers);
      }

      if (url.pathname === "/hit" && req.method === "POST") {
        if (!(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "json only" }, headers);
        let body;
        try {
          body = await readJson(req);
        } catch {
          return send(res, 400, { error: "bad json" }, headers);
        }
        const path = typeof body.path === "string" ? body.path : "";
        if (!ALLOWED_PATH.test(path) || path.length > 200) return send(res, 400, { error: "bad path" }, headers);
        const current = (await totals.findOne({ _id: path }))?.views || 0;
        if (req.headers.dnt === "1" || req.headers["sec-gpc"] === "1") return send(res, 200, { views: current, counted: false }, headers);

        // Render and most hosts put the client address first in X-Forwarded-For.
        const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "0.0.0.0";
        const minute = Math.floor(Date.now() / 60000);
        const rateId = `${sha256(ip)}|${minute}`;
        await rate.updateOne({ _id: rateId }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 120_000) } }, { upsert: true });
        if (((await rate.findOne({ _id: rateId }))?.count || 0) > MAX_HITS_PER_MINUTE) return send(res, 429, { error: "too many hits" }, headers);

        const day = today();
        const salt = await dailySalt(day);
        const fingerprint = sha256(`${salt}|${ip}|${req.headers["user-agent"] || ""}|${path}`);
        const seenId = `${day}|${fingerprint}`;
        const unique = !(await seen.findOne({ _id: seenId }));
        if (unique) await seen.updateOne({ _id: seenId }, { $setOnInsert: { expiresAt: new Date(Date.now() + 2 * DAY_MS) } }, { upsert: true });

        await hits.updateOne({ _id: `${day}|${path}` }, { $inc: { views: 1, uniques: unique ? 1 : 0 }, $setOnInsert: { day, path } }, { upsert: true });
        const host = referrerHost(typeof body.referrer === "string" ? body.referrer : "", origins);
        if (host) await referrers.updateOne({ _id: `${day}|${host}` }, { $inc: { count: 1 }, $setOnInsert: { day, host } }, { upsert: true });
        await totals.updateOne({ _id: path }, { $inc: { views: 1 } }, { upsert: true });
        return send(res, 200, { views: current + 1 }, headers);
      }

      if (url.pathname === "/export" && req.method === "GET") {
        const auth = req.headers.authorization || "";
        if (!env.EXPORT_SECRET || auth !== `Bearer ${env.EXPORT_SECRET}`) return send(res, 401, { error: "unauthorized" }, { "Content-Type": "application/json" });
        const days = {};
        for (const h of await hits.find({}).toArray()) {
          const d = (days[h.day] ??= { views: {}, uniques: {}, referrers: {} });
          d.views[h.path] = h.views || 0;
          if (h.uniques) d.uniques[h.path] = h.uniques;
        }
        for (const r of await referrers.find({}).toArray()) {
          const d = (days[r.day] ??= { views: {}, uniques: {}, referrers: {} });
          d.referrers[r.host] = r.count || 0;
        }
        const totalMap = {};
        for (const t of await totals.find({}).toArray()) totalMap[t._id] = t.views || 0;
        return send(res, 200, { version: 1, days, totals: totalMap }, { "Content-Type": "application/json" });
      }

      if (url.pathname === "/" || url.pathname === "/health") return send(res, 200, { ok: true, service: "open.blog counter" }, headers);
      return send(res, 404, { error: "not found" }, headers);
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: "server error" }, headers);
    }
  }

  return { handler, ensureIndexes };
}

// Run as a program: connect to MongoDB and listen.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const { MongoClient } = await import("mongodb");
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const app = createApp(client.db(process.env.MONGODB_DB || "openblog"));
  await app.ensureIndexes();
  const port = Number(process.env.PORT || 3000);
  createServer(app.handler).listen(port, () => console.log(`open.blog counter listening on ${port}`));
}
