// An in-memory stand-in for the Supabase REST API behind the social routes, shared by the node tests
// and the browser test of the Social screen. It follows the rules the real schema enforces that the
// routes rely on: eq./in. filters, ordering, limits, conditional updates and the unique idempotency index.

export const SITE = "lantern-studios";
export const LINKEDIN = "11111111-1111-4111-8111-111111111111";
export const FACEBOOK = "22222222-2222-4222-8222-222222222222";
export const GONE = "33333333-3333-4333-8333-333333333333";
export const REAUTH = "44444444-4444-4444-8444-444444444444";
export const OTHER_SITE = "55555555-5555-4555-8555-555555555555";
export const FUTURE = "66666666-6666-4666-8666-666666666666";

// A tiny PostgREST: eq./in. filters, order, limit, conditional PATCH, a unique idempotency index.
export function fakeStorage({ onPatch, ignoreFilters = false } = {}) {
  const accounts = [
    { id: LINKEDIN, site_id: SITE, provider: "linkedin", kind: "member", display_name: "Mikey Nichols", status: "connected" },
    { id: FACEBOOK, site_id: SITE, provider: "facebook", kind: "page", display_name: "Lantern Page", status: "connected" },
    { id: GONE, site_id: SITE, provider: "linkedin", kind: "member", display_name: "Old", status: "disconnected" },
    { id: REAUTH, site_id: SITE, provider: "linkedin", kind: "member", display_name: "Stale", status: "needs-reauth" },
    { id: OTHER_SITE, site_id: "other-site", provider: "linkedin", kind: "member", display_name: "Foreign", status: "connected" },
    { id: FUTURE, site_id: SITE, provider: "threads", kind: "member", display_name: "Future", status: "connected" },
  ];
  const posts = [];
  const calls = [];
  let sequence = 0;
  const matches = (row, params) => {
    for (const [name, filter] of params) {
      if (["select", "order", "limit"].includes(name)) continue;
      const [operator, ...rest] = filter.split(".");
      const value = rest.join(".");
      const actual = String(row[name]);
      if (operator === "eq" && actual !== value) return false;
      if (operator === "in" && !value.slice(1, -1).split(",").includes(actual)) return false;
    }
    return true;
  };
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    const table = target.pathname.split("/").pop();
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, table, query: target.search, body, headers: options.headers });
    const rows = table === "openblog_social_accounts" ? accounts : posts;
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (method === "GET") {
      let found = ignoreFilters ? [...rows] : rows.filter((row) => matches(row, target.searchParams));
      const order = target.searchParams.get("order");
      if (order) {
        const [column, direction] = order.split(".");
        found.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (direction === "desc" ? -1 : 1));
      }
      const limit = Number(target.searchParams.get("limit"));
      if (limit) found = found.slice(0, limit);
      return json(200, found);
    }
    if (method === "POST") {
      if (posts.some((p) => p.site_id === body.site_id && p.account_id === body.account_id && p.idempotency_key === body.idempotency_key)) return json(409, { code: "23505", message: "duplicate key value violates unique constraint" });
      sequence += 1;
      const row = {
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence).padStart(12, "0")}`,
        version: 1,
        attempt_count: 0,
        claimed_by: null,
        last_error_code: null,
        provider_post_id: null,
        published_at: null,
        canceled_at: null,
        ...body,
      };
      posts.push(row);
      return json(201, [row]);
    }
    if (method === "PATCH") {
      onPatch?.(posts);
      const changed = [];
      for (const row of posts) {
        if (matches(row, target.searchParams)) {
          Object.assign(row, body);
          changed.push(row);
        }
      }
      return json(200, changed);
    }
    return json(405, {});
  };
  return { fetchImpl, accounts, posts, calls };
}

