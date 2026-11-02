// Pure model behind <ob-fetch-lab>: a pretend server, a fetch() trace, and a small pretend
// Web Storage with a quota. No DOM, no network. Everything is deterministic so lessons and
// tests can rely on it.

const JSON_TYPE = "application/json";
const POSTS = [
  { id: 1, title: "Hello, fetch" },
  { id: 2, title: "Storage basics" },
];

export const presets = [
  { label: "List posts", method: "GET", path: "/api/posts" },
  { label: "One post", method: "GET", path: "/api/posts/1" },
  { label: "Missing post (404)", method: "GET", path: "/api/posts/99" },
  { label: "Server error (500)", method: "GET", path: "/api/error" },
  { label: "Broken JSON", method: "GET", path: "/api/broken" },
  { label: "Not JSON at all", method: "GET", path: "/api/text" },
  { label: "Network down", method: "GET", path: "/api/offline" },
  {
    label: "Create post", method: "POST", path: "/api/posts",
    headers: "Content-Type: application/json", body: '{"title": "My first post"}',
  },
];

export function parseHeaders(text = "") {
  const headers = {};
  const ignored = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(":");
    if (at < 1) ignored.push(line.trim());
    else headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { headers, ignored };
}

function respond(status, statusText, body, type = JSON_TYPE, extra = {}) {
  return {
    status, statusText, body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": type, ...extra },
  };
}

// The pretend server. Returns null for a network failure (fetch() rejects with TypeError).
export function handle({ method = "GET", path = "/", headers = {}, body = "" }) {
  const url = path.split("?")[0].replace(/^https?:\/\/[^/]+/, "").replace(/(.)\/$/, "$1");
  method = method.toUpperCase();
  if (url === "/api/offline") return null;
  let match;
  if (url === "/api/posts") {
    if (!["GET", "POST"].includes(method)) return respond(405, "Method Not Allowed", { error: "Use GET or POST here." }, JSON_TYPE, { allow: "GET, POST" });
    if (method === "GET") return respond(200, "OK", POSTS);
    if (!(headers["content-type"] || "").startsWith(JSON_TYPE)) {
      return respond(415, "Unsupported Media Type", { error: "Send Content-Type: application/json." });
    }
    let data;
    try { data = JSON.parse(body); } catch { return respond(400, "Bad Request", { error: "The body is not valid JSON." }); }
    if (typeof data?.title !== "string" || !data.title.trim()) return respond(422, "Unprocessable Content", { error: "A post needs a title." });
    return respond(201, "Created", { id: POSTS.length + 1, title: data.title }, JSON_TYPE, { location: `/api/posts/${POSTS.length + 1}` });
  }
  if ((match = url.match(/^\/api\/posts\/(\d+)$/))) {
    if (method !== "GET") return respond(405, "Method Not Allowed", { error: "Use GET here." }, JSON_TYPE, { allow: "GET" });
    const post = POSTS.find((item) => item.id === Number(match[1]));
    return post ? respond(200, "OK", post) : respond(404, "Not Found", { error: "Post not found." });
  }
  if (url === "/api/broken") return respond(200, "OK", '{"id": 1, "title": "Oops",}');
  if (url === "/api/text") return respond(200, "OK", "Plain words, not JSON.", "text/plain");
  if (url === "/api/error") return respond(500, "Internal Server Error", "Something broke on the server.", "text/plain");
  return respond(404, "Not Found", "<h1>Not Found</h1>", "text/html");
}

// What the reader's code would observe, step by step, and what to learn from it.
export function trace(request) {
  const response = handle(request);
  if (!response) {
    return {
      response: null, ok: false, json: { ok: false, error: "never read" },
      lessons: ["The network failed, so fetch() rejected with a TypeError. This is the only case where fetch() rejects. Handle it with try/catch."],
    };
  }
  const ok = response.status >= 200 && response.status < 300;
  let json;
  try { json = { ok: true, value: JSON.parse(response.body) }; } catch (error) { json = { ok: false, error: error.message }; }
  const lessons = [];
  if (!ok) lessons.push(`fetch() resolved even though the status is ${response.status}. HTTP errors are not rejections: check response.ok before reading the body.`);
  if (ok && !json.ok) lessons.push(`The request succeeded but response.json() would throw a SyntaxError: ${json.error}. A good status does not guarantee a valid body.`);
  if (ok && !json.ok && !response.headers["content-type"].startsWith(JSON_TYPE)) lessons.push(`The server said ${response.headers["content-type"]}. Check the Content-Type, or read response.text() instead.`);
  if (response.status === 415) lessons.push("A POST with a JSON body needs a Content-Type: application/json header, or the server cannot tell what it received.");
  if (response.status === 201) lessons.push("201 Created, and the Location header says where the new post lives.");
  if (ok && json.ok && !lessons.length) lessons.push("Success: status 2xx, valid JSON. Now you can use the data or store it.");
  return { response, ok, json, lessons };
}

export function snippet({ method = "GET", path = "/", headers = "", body = "", credentials }) {
  const { headers: parsed } = parseHeaders(headers);
  const options = [];
  if (method !== "GET") options.push(`  method: ${JSON.stringify(method)},`);
  if (credentials) options.push(`  credentials: ${JSON.stringify(credentials)},`);
  if (Object.keys(parsed).length) {
    options.push("  headers: {", ...Object.entries(parsed).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`), "  },");
  }
  if (method !== "GET" && method !== "HEAD" && body) options.push(`  body: ${JSON.stringify(body)},`);
  return [
    `const response = await fetch(${JSON.stringify(path)}${options.length ? ", {" : ");"}`,
    ...(options.length ? [...options, "});"] : []),
    "if (!response.ok) throw new Error(`HTTP ${response.status}`);",
    "const data = await response.json();",
  ].join("\n");
}

// ---- Pretend Web Storage ---------------------------------------------------------------

export const QUOTA = 256;

export function createStorage(quota = QUOTA) {
  return { quota, items: {} };
}

export function usage(storage) {
  return Object.entries(storage.items).reduce((sum, [key, value]) => sum + key.length + value.length, 0);
}

// Web Storage stores strings only: anything else goes through String(), so an object
// becomes "[object Object]". That is the lesson, so the model does it faithfully.
export function setItem(storage, key, value) {
  if (!key) return { storage, error: "Give the item a key." };
  const text = String(value);
  const items = { ...storage.items, [key]: text };
  const next = { ...storage, items };
  if (usage(next) > storage.quota) {
    return { storage, error: `QuotaExceededError: storing "${key}" would use ${usage(next)} of ${storage.quota} characters.` };
  }
  return { storage: next, stored: text };
}

export function getItem(storage, key) {
  return key in storage.items ? storage.items[key] : null;
}

export function removeItem(storage, key) {
  const { [key]: _gone, ...items } = storage.items;
  return { ...storage, items };
}

export function clear(storage) {
  return { ...storage, items: {} };
}

// ---- Lesson scenarios: login, caching, testing -------------------------------------------
// Opt-in through the fence's `lesson="login|caching|testing"`. Without one, the lab is the
// original lab above and none of this runs. Everything here is pretend: a cookie jar, an HTTP
// cache and a clock that only moves when the reader presses a button.

export const APP_ORIGIN = "https://app.example.test";
export const API_ORIGIN = "https://api.example.test";
export const CREDENTIALS = ["omit", "same-origin", "include"];
const SESSION = "session=s3cr3t-1";

export const serverDefaults = { allowOrigin: APP_ORIGIN, allowCredentials: true };

export const scenarios = {
  login: {
    label: "Login and credentials",
    note: "A pretend page at https://app.example.test talks to a pretend API. The cookie jar below is simulated: nothing is stored in your browser.",
    presets: [
      {
        label: "1. Log in", method: "POST", path: `${API_ORIGIN}/login`, headers: "Content-Type: application/json",
        body: '{"user": "mika", "password": "pw"}', credentials: "include", server: { ...serverDefaults },
        explain: "The API answers 200 and sends Set-Cookie. The browser keeps the cookie only because credentials is \"include\". Look at the cookie jar.",
      },
      {
        label: "2. Who am I? (include)", method: "GET", path: `${API_ORIGIN}/me`, credentials: "include", server: { ...serverDefaults },
        explain: "With credentials: \"include\" the cookie rides along, so the API knows you. Log in first, then send this.",
      },
      {
        label: "Who am I? (omit)", method: "GET", path: `${API_ORIGIN}/me`, credentials: "omit", server: { ...serverDefaults },
        explain: "credentials: \"omit\" sends no cookie, so the API answers 401 even though you logged in. Compare the cookie line under the response.",
      },
      {
        label: "Who am I? (same-origin)", method: "GET", path: `${API_ORIGIN}/me`, credentials: "same-origin", server: { ...serverDefaults },
        explain: "The default. The API lives on another origin than the page, so \"same-origin\" sends no cookie here and you get 401.",
      },
      {
        label: "CORS: wildcard origin", method: "GET", path: `${API_ORIGIN}/me`, credentials: "include", server: { allowOrigin: "*", allowCredentials: true },
        explain: "The server allows any origin with *, which is not allowed when credentials are included. The browser blocks your code from reading the reply.",
      },
      {
        label: "CORS: no credentials header", method: "GET", path: `${API_ORIGIN}/me`, credentials: "include", server: { allowOrigin: APP_ORIGIN, allowCredentials: false },
        explain: "The origin is right, but the server did not send Access-Control-Allow-Credentials: true, so the browser still blocks the reply.",
      },
      {
        label: "Same-origin /me", method: "GET", path: "/me", credentials: "same-origin", server: { ...serverDefaults },
        explain: "A path with no host goes to the page's own origin. Cookies are sent by default there, and CORS does not apply.",
      },
    ],
  },
  caching: {
    label: "HTTP caching",
    note: "A pretend browser cache and a pretend clock. Time only moves when you press the button.",
    presets: [
      {
        label: "GET /report", method: "GET", path: "/report",
        explain: "The first request has to go to the server. The reply says Cache-Control: max-age=60, so the browser may reuse it for 60 seconds, and gives an ETag.",
      },
      {
        label: "GET /report (no-store)", method: "GET", path: "/report-no-store",
        explain: "Cache-Control: no-store tells the browser to keep nothing. Every request goes to the server, however often you press Send.",
      },
    ],
  },
  testing: {
    label: "Testing fetch code",
    note: "Replace the pretend fetch with a stub that returns what you choose, then watch what the function under test does. No server is involved.",
    presets: [
      { label: "Success", kind: "response", status: 200, body: '{"id": 1, "title": "Hello, fetch"}', explain: "The happy path: the stub answers 200 with a post. The function returns the title." },
      { label: "Not found (404)", kind: "response", status: 404, body: '{"error": "Post not found."}', explain: "A 404 still resolves in real fetch, so the function has to check response.ok itself. Your stub can check that it does." },
      { label: "Network error", kind: "network", status: 0, body: "", explain: "A network failure makes fetch reject with a TypeError. The stub does the same, without unplugging anything." },
      { label: "Slow (timeout)", kind: "slow", status: 200, body: '{"id": 1, "title": "Hello, fetch"}', delay: 8000, explain: "The stub answers after 8000 ms, but the function gives up at 3000 ms. The test does not wait: the delay is simulated." },
      { label: "Broken JSON", kind: "response", status: 200, body: '{"id": 1,', explain: "A 200 with a body that is not valid JSON: response.json() throws a SyntaxError." },
    ],
  },
};

export function createWorld() {
  return { now: 0, cookie: null, cache: {}, serverHits: 0, reportVersion: 1 };
}

export const advance = (world, seconds = 30) => ({ ...world, now: world.now + seconds });
export const changeReport = (world) => ({ ...world, reportVersion: world.reportVersion + 1 });
export const clearCache = (world) => ({ ...world, cache: {} });
export const clearCookies = (world) => ({ ...world, cookie: null });

export function reportEtag(world) {
  return `"v${world.reportVersion}"`;
}

function splitUrl(path) {
  const match = path.match(/^(https?:\/\/[^/]+)(\/[^?#]*)?/i);
  if (match) return { origin: match[1].toLowerCase(), pathname: match[2] || "/" };
  return { origin: APP_ORIGIN, pathname: path.split(/[?#]/)[0] || "/" };
}

function describe(response) {
  const ok = response.status >= 200 && response.status < 300;
  let json;
  try { json = { ok: true, value: JSON.parse(response.body) }; } catch (error) { json = { ok: false, error: error.message }; }
  return { ok, json };
}

// The CORS decision a browser makes before it hands a cross-origin response to your code.
// Returns null when allowed, otherwise the reason it is blocked.
export function corsVerdict(headers, credentials) {
  const origin = headers["access-control-allow-origin"];
  if (!origin) return "The response has no Access-Control-Allow-Origin header.";
  if (credentials === "include") {
    if (origin === "*") return "Access-Control-Allow-Origin is *, which is not allowed when the request includes credentials. Name the exact origin.";
    if (origin !== APP_ORIGIN) return `Access-Control-Allow-Origin is ${origin}, but the page is ${APP_ORIGIN}.`;
    if (headers["access-control-allow-credentials"] !== "true") return "The response lacks Access-Control-Allow-Credentials: true, which a credentialed request needs.";
    return null;
  }
  if (origin !== "*" && origin !== APP_ORIGIN) return `Access-Control-Allow-Origin is ${origin}, but the page is ${APP_ORIGIN}.`;
  return null;
}

function reportResponse(world, pathname) {
  const headers = pathname === "/report-no-store"
    ? { "cache-control": "no-store" }
    : { "cache-control": "max-age=60", etag: reportEtag(world) };
  return respond(200, "OK", { version: world.reportVersion, total: 40 + world.reportVersion }, JSON_TYPE, headers);
}

function fromServer(world, key, pathname, base, lesson) {
  const response = reportResponse(world, pathname);
  const cache = pathname === "/report-no-store"
    ? world.cache
    : { ...world.cache, [key]: { response, etag: response.headers.etag, storedAt: world.now, maxAge: 60 } };
  return {
    ...base, world: { ...world, serverHits: world.serverHits + 1, cache }, wire: response, response,
    ...describe(response), lessons: [lesson],
  };
}

// Sends one request through the pretend browser and server. Returns the next world and
// everything the lab shows: the wire response, what the code sees (null when blocked), and
// the lessons. `source` is "network", "cache" or "revalidated".
export function exchange(world, request) {
  const method = (request.method || "GET").toUpperCase();
  const credentials = request.credentials || "same-origin";
  const { origin, pathname } = splitUrl(request.path || "/");
  const cross = origin !== APP_ORIGIN;
  const base = {
    world, source: "network", wire: null, response: null, blocked: null, cookieSent: false, sent: {},
    lessons: [], ok: false, json: { ok: false, error: "never read" },
  };
  if (cross && origin !== API_ORIGIN) {
    return { ...base, lessons: [`No server answers at that host, so fetch() rejected with a TypeError. This lab's pretend API lives at ${API_ORIGIN}.`] };
  }

  if (method === "GET" && /^\/report(-no-store)?$/.test(pathname)) {
    const key = origin + pathname;
    const entry = world.cache[key];
    if (entry && world.now - entry.storedAt < entry.maxAge) {
      const age = world.now - entry.storedAt;
      const response = { ...entry.response, headers: { ...entry.response.headers, age: String(age) } };
      return {
        ...base, source: "cache", response, ...describe(response),
        lessons: [`Served from the cache: the saved copy is ${age} s old and may be reused until it is 60 s old. The server never saw this request. Advance the clock to see what happens next.`],
      };
    }
    if (entry) {
      const sent = { "if-none-match": entry.etag };
      if (entry.etag === reportEtag(world)) {
        const next = { ...world, serverHits: world.serverHits + 1, cache: { ...world.cache, [key]: { ...entry, storedAt: world.now } } };
        const wire = { status: 304, statusText: "Not Modified", body: "", headers: { etag: entry.etag, "cache-control": "max-age=60" } };
        const response = { ...entry.response };
        return {
          ...base, world: next, source: "revalidated", wire, response, sent, ...describe(response),
          lessons: ["The saved copy was stale, so the browser asked: If-None-Match with the saved ETag. The server answered 304 Not Modified with no body, and the browser reused its copy. Your code still sees status 200 and the full body."],
        };
      }
      return fromServer(world, key, pathname, { ...base, sent }, "The ETag no longer matches, so the server sent the new report in full (200) and the old copy was replaced.");
    }
    return fromServer(world, key, pathname, base, pathname === "/report-no-store"
      ? "Cache-Control: no-store means the browser keeps no copy. Send it again: it still goes to the server."
      : "A cache miss: the request went to the server. The reply carries Cache-Control: max-age=60 and an ETag, so the browser saved a copy.");
  }

  const cookieSent = Boolean(world.cookie) && (cross ? credentials === "include" : credentials !== "omit");
  let response;
  let loggedIn = false;
  if (pathname === "/login") {
    if (method !== "POST") response = respond(405, "Method Not Allowed", { error: "Use POST to log in." }, JSON_TYPE, { allow: "POST" });
    else {
      let data;
      try { data = JSON.parse(request.body || ""); } catch { data = null; }
      if (typeof data?.user !== "string" || !data.user.trim()) response = respond(400, "Bad Request", { error: "Send JSON with a user." });
      else {
        response = respond(200, "OK", { user: data.user.trim() }, JSON_TYPE, { "set-cookie": `${SESSION}; HttpOnly; Secure; SameSite=None` });
        loggedIn = true;
      }
    }
  } else if (pathname === "/me") {
    if (method !== "GET") response = respond(405, "Method Not Allowed", { error: "Use GET here." }, JSON_TYPE, { allow: "GET" });
    else if (cookieSent) response = respond(200, "OK", { user: "mika" });
    else response = respond(401, "Unauthorized", { error: "Not logged in." });
  } else {
    response = handle({ method, path: pathname, headers: request.headers || {}, body: request.body });
    if (!response) return { ...base, cookieSent, lessons: ["The network failed, so fetch() rejected with a TypeError."] };
  }

  let blocked = null;
  if (cross) {
    const server = { ...serverDefaults, ...(request.server || {}) };
    const extra = {};
    if (server.allowOrigin && server.allowOrigin !== "none") extra["access-control-allow-origin"] = server.allowOrigin;
    if (server.allowCredentials) extra["access-control-allow-credentials"] = "true";
    response = { ...response, headers: { ...response.headers, ...extra } };
    blocked = corsVerdict(response.headers, credentials);
  }
  const hits = { ...world, serverHits: world.serverHits + 1 };
  const stored = loggedIn && !blocked && (cross ? credentials === "include" : credentials !== "omit");
  const next = stored ? { ...hits, cookie: SESSION } : hits;
  if (blocked) {
    return {
      ...base, world: next, wire: response, blocked, cookieSent,
      lessons: [`The server received the request and answered ${response.status}, but the browser blocked your code from reading it: ${blocked} Your code sees a TypeError, not the response. The fix is on the server.`],
    };
  }
  let lesson;
  if (loggedIn) {
    lesson = stored
      ? "Logged in. The browser stored the cookie from Set-Cookie. HttpOnly keeps it out of JavaScript: response.headers.get(\"set-cookie\") is always null in your code."
      : `The server logged you in, but the browser ignored Set-Cookie because credentials is "${credentials}". Nothing was stored.`;
  } else if (pathname === "/me" && response.status === 401) {
    lesson = !world.cookie
      ? "401: there is no cookie yet. Log in first."
      : `401 even though a cookie exists: with credentials "${credentials}" the browser did not send it${cross ? " to another origin" : ""}. Cross-origin requests need credentials: "include".`;
  } else if (pathname === "/me" && response.status === 200) {
    lesson = cross
      ? "200: the cookie was sent (credentials: \"include\") and the server's CORS headers let your page read the answer."
      : "200: same-origin requests send cookies by default and need no CORS headers.";
  } else lesson = `The server answered ${response.status}.`;
  return { ...base, world: next, wire: response, response, cookieSent, ...describe(response), lessons: [lesson] };
}

// The cache as the reader sees it: one line per saved copy.
export function cacheEntries(world) {
  return Object.entries(world.cache).map(([key, entry]) => {
    const age = world.now - entry.storedAt;
    return { key: key.replace(APP_ORIGIN, ""), etag: entry.etag, age, fresh: age < entry.maxAge };
  });
}

// ---- Testing: replace fetch with a stub -------------------------------------------------

export const TIMEOUT_MS = 3000;

export const functionUnderTest = [
  "async function getPostTitle(fetchFn, id) {",
  "  const response = await fetchFn(`/api/posts/${id}`, {",
  `    signal: AbortSignal.timeout(${TIMEOUT_MS}),`,
  "  });",
  "  if (!response.ok) throw new Error(`HTTP ${response.status}`);",
  "  const post = await response.json();",
  "  return post.title;",
  "}",
].join("\n");

// Runs getPostTitle against a stub, step by step, without a network or a real timer.
// stub: { kind: "response" | "network" | "slow", status, body, delay }
export function runUnderTest(stub, id = 1) {
  const calls = [`stub fetch called with "/api/posts/${id}" and a ${TIMEOUT_MS} ms timeout signal`];
  const fail = (name, message, lesson) => ({ outcome: "throws", error: { name, message }, calls, lessons: [lesson] });
  if (stub.kind === "network") {
    return fail("TypeError", "Failed to fetch", "The stub rejected, so getPostTitle rejected too. A test can assert that with assert.rejects.");
  }
  if (stub.kind === "slow") {
    const delay = Number(stub.delay) || 0;
    if (delay > TIMEOUT_MS) {
      calls.push(`the stub would answer after ${delay} ms; the timeout fires at ${TIMEOUT_MS} ms`);
      return fail("TimeoutError", `The operation timed out after ${TIMEOUT_MS} ms`, "The signal aborted before the stub answered. The test never waited: a stub can model a slow server instantly.");
    }
    calls.push(`the stub answers after ${delay} ms, inside the ${TIMEOUT_MS} ms limit`);
  }
  const status = Number(stub.status) || 200;
  calls.push(`stub returned new Response(body, { status: ${status} })`);
  if (status < 200 || status >= 300) {
    return fail("Error", `HTTP ${status}`, `The function checked response.ok and threw. Without that check a ${status} would have been parsed as if it were a post.`);
  }
  let post;
  try { post = JSON.parse(stub.body); } catch (error) {
    return fail("SyntaxError", error.message, "response.json() threw because the stub's body is not valid JSON. A good status does not guarantee a good body.");
  }
  const title = post?.title;
  return {
    outcome: "returns", value: title, calls,
    lessons: [title === undefined
      ? "The function returned undefined: the stub's body has no title. Tests should assert on the value, not just that nothing threw."
      : "The function returned the title. The same function runs against the real fetch in production."],
  };
}

// The test a reader could paste into their own project for the chosen stub.
export function testSnippet(stub) {
  const lines = [];
  if (stub.kind === "network") lines.push("const stub = async () => { throw new TypeError(\"Failed to fetch\"); };");
  else {
    const answer = `new Response(${JSON.stringify(stub.body || "")}, { status: ${Number(stub.status) || 200} })`;
    if (stub.kind === "slow") {
      lines.push("const stub = (url, { signal }) => new Promise((resolve, reject) => {",
        `  const timer = setTimeout(() => resolve(${answer}), ${Number(stub.delay) || 0});`,
        "  signal.addEventListener(\"abort\", () => { clearTimeout(timer); reject(signal.reason); });",
        "});");
    } else lines.push(`const stub = async () => ${answer};`);
  }
  const result = runUnderTest(stub);
  lines.push(result.outcome === "returns"
    ? `assert.equal(await getPostTitle(stub, 1), ${JSON.stringify(result.value)});`
    : `await assert.rejects(getPostTitle(stub, 1), { name: ${JSON.stringify(result.error.name)} });`);
  return lines.join("\n");
}
