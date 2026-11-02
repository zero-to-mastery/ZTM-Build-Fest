// <ob-fetch-lab> is a simulated network inspector and Web Storage panel for lessons. The
// "server" and the "storage" are in-memory models, so readers can trigger 404s, broken JSON,
// network failures and quota errors safely and offline. Children of the element are the
// no-JavaScript fallback; they are hidden once the lab starts. Nothing is stored or sent.
import {
  presets, parseHeaders, trace, snippet,
  createStorage, usage, setItem, getItem, removeItem, clear,
  scenarios, CREDENTIALS, createWorld, advance, changeReport, clearCache, clearCookies, exchange,
  cacheEntries, serverDefaults, APP_ORIGIN, functionUnderTest, runUnderTest, testSnippet,
} from "./ob-fetch-model.js";
import { ObLab, defineLab, el, field, reducedMotion } from "./ob-lab.js";

const STAGES = [["request", "Request"], ["response", "Response"], ["parse", "Parse"], ["store", "Store"]];

class ObFetchLab extends ObLab {
  setup() {
    const scenario = Object.hasOwn(scenarios, this.dataset.lesson) ? scenarios[this.dataset.lesson] : null;
    if (scenario) { this.setupScenario(scenario); return; }
    this.storage = createStorage();
    this.parsed = null;

    this.append(
      el("p", { class: "ob-fetch-note" }, "A simulated server and a simulated browser storage: nothing leaves this page. Edit the request, send it, and watch what your code would see."),
      this.buildRequest(), this.buildPipeline(), this.buildResult(), this.buildStorage());
    this.select(presets[0]);
  }

  buildRequest() {
    const box = el("section", { class: "ob-fetch-panel", "aria-label": "Request" });
    const presetRow = el("div", { class: "ob-fetch-presets", role: "group", "aria-label": "Example requests" });
    for (const preset of presets) {
      const button = el("button", { type: "button" }, preset.label);
      button.addEventListener("click", () => { this.select(preset); this.send(); });
      presetRow.append(button);
    }
    this.method = el("select");
    for (const verb of ["GET", "POST", "PUT", "DELETE"]) this.method.append(el("option", { value: verb }, verb));
    this.path = el("input", { type: "text", autocomplete: "off", spellcheck: "false" });
    this.headers = el("textarea", { rows: "2", spellcheck: "false", placeholder: "Content-Type: application/json" });
    this.body = el("textarea", { rows: "2", spellcheck: "false", placeholder: '{"title": "My first post"}' });
    const form = el("form", { class: "ob-fetch-form" });
    form.append(
      field("Method", this.method), field("URL", this.path),
      field("Headers (Name: value, one per line)", this.headers), field("Body", this.body),
      el("button", { type: "submit" }, "Send request"));
    form.addEventListener("submit", (event) => { event.preventDefault(); this.send(); });
    this.snippet = el("pre", { class: "ob-fetch-code", tabindex: "0", "aria-label": "Equivalent fetch code" });
    form.addEventListener("input", () => this.showSnippet());
    box.append(presetRow, form, this.snippet);
    return box;
  }

  buildPipeline(stages = STAGES) {
    this.stages = {};
    const list = el("ol", { class: "ob-fetch-stages", "aria-label": "Request pipeline" });
    for (const [key, label] of stages) {
      const item = el("li", { "data-stage": key }, label);
      this.stages[key] = item;
      list.append(item);
    }
    return list;
  }

  buildResult() {
    const box = el("div", { class: "ob-fetch-result" });
    this.responseView = el("pre", { class: "ob-fetch-out", tabindex: "0", "aria-label": "Raw response" });
    this.codeView = el("div", { class: "ob-fetch-out ob-fetch-sees" });
    this.lessons = el("p", { class: "ob-fetch-lesson", role: "status" });
    const left = el("section", { class: "ob-fetch-panel" });
    left.append(el("h3", {}, "Response on the wire"), this.responseView);
    const right = el("section", { class: "ob-fetch-panel" });
    right.append(el("h3", {}, "What your code sees"), this.codeView, this.lessons);
    box.append(left, right);
    return box;
  }

  buildStorage() {
    const box = el("section", { class: "ob-fetch-panel ob-fetch-storage", "aria-label": "Storage" });
    this.meter = el("meter", { min: "0", max: String(this.storage.quota) });
    this.meterText = el("span");
    const usageRow = el("p", { class: "ob-fetch-usage" });
    usageRow.append(el("span", {}, "localStorage "), this.meter, this.meterText);
    this.items = el("ul", { class: "ob-fetch-items", "aria-label": "Stored items" });
    this.key = el("input", { type: "text", value: "posts", autocomplete: "off", spellcheck: "false" });
    this.stringify = el("input", { type: "checkbox", checked: "" });
    const check = el("label", { class: "ob-fetch-check" });
    check.append(this.stringify, " JSON.stringify before saving");
    this.storageOut = el("pre", { class: "ob-fetch-out", role: "status", "aria-label": "Storage result" });
    this.saveButton = el("button", { type: "button" }, "Save parsed response");
    this.saveButton.addEventListener("click", () => this.save());
    const actions = el("div", { class: "ob-fetch-actions" });
    actions.append(this.saveButton);
    for (const [text, run] of [
      ["Read back + parse", () => this.read()],
      ["Remove key", () => this.drop()],
      ["Clear all", () => this.empty()],
    ]) {
      const button = el("button", { type: "button" }, text);
      button.addEventListener("click", run);
      actions.append(button);
    }
    box.append(el("h3", {}, "Browser storage"), usageRow, this.items, field("Key", this.key), check,
      actions, this.storageOut);
    this.renderStorage();
    this.storageOut.textContent = "Send a request that returns JSON, then save it. Untick the checkbox to see what happens when you skip JSON.stringify.";
    return box;
  }

  select(preset) {
    this.method.value = preset.method;
    this.path.value = preset.path;
    this.headers.value = preset.headers ?? "";
    this.body.value = preset.body ?? "";
    this.showSnippet();
  }

  current() {
    const { headers } = parseHeaders(this.headers.value);
    return { method: this.method.value, path: this.path.value.trim() || "/", headers, body: this.body.value };
  }

  showSnippet() {
    this.snippet.textContent = snippet({
      method: this.method.value, path: this.path.value.trim() || "/",
      headers: this.headers.value, body: this.body.value, credentials: this.credentials?.value,
    });
  }

  mark(done, active) {
    for (const [key] of STAGES) {
      const state = key === active ? "active" : done.includes(key) ? "done" : "";
      if (state) this.stages[key].dataset.state = state;
      else delete this.stages[key].dataset.state;
    }
  }

  async send() {
    const request = this.current();
    this.parsed = null;
    this.saveButton.disabled = true;
    this.mark([], "request");
    this.responseView.textContent = "Waiting for the response…";
    this.codeView.textContent = "";
    this.lessons.textContent = "";
    await new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 0 : 250));
    const result = trace(request);
    this.showResult(result);
  }

  showResult({ response, ok, json, lessons }) {
    if (!response) {
      this.mark(["request"], null);
      this.stages.response.dataset.state = "error";
      this.responseView.textContent = "(no response: the request never reached a server)";
      this.codeView.textContent = "await fetch(…) rejected\nTypeError: Failed to fetch";
      this.lessons.textContent = lessons[0];
      return;
    }
    const head = Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join("\n");
    this.responseView.textContent = `HTTP ${response.status} ${response.statusText}\n${head}\n\n${response.body}`;
    const lines = [
      `response.status  → ${response.status}`,
      `response.ok      → ${ok}`,
      json.ok ? `await response.json() → ${JSON.stringify(json.value)}` : `await response.json() → throws SyntaxError\n  ${json.error}`,
    ];
    this.codeView.textContent = lines.join("\n");
    this.lessons.textContent = lessons.join(" ");
    if (ok && json.ok) this.parsed = json.value;
    this.mark(["request"], null);
    this.stages.response.dataset.state = ok ? "done" : "error";
    this.stages.parse.dataset.state = json.ok ? "done" : "error";
    this.saveButton.disabled = this.parsed === null;
  }

  save() {
    const value = this.stringify.checked ? JSON.stringify(this.parsed) : this.parsed;
    const result = setItem(this.storage, this.key.value.trim(), value);
    if (result.error) {
      this.storageOut.textContent = result.error;
      this.storageOut.dataset.error = "true";
    } else {
      this.storage = result.storage;
      this.storageOut.dataset.error = "false";
      this.stages.store.dataset.state = "done";
      this.storageOut.textContent = `localStorage.setItem("${this.key.value.trim()}", ${this.stringify.checked ? "JSON.stringify(data)" : "data"})\nstored: ${result.stored}${this.stringify.checked ? "" : "\n\nThat is the string \"[object Object]\", not your data. Web Storage only stores strings."}`;
    }
    this.renderStorage();
  }

  read() {
    const key = this.key.value.trim();
    const raw = getItem(this.storage, key);
    this.storageOut.dataset.error = "false";
    if (raw === null) {
      this.storageOut.textContent = `localStorage.getItem("${key}") → null\nNothing is stored under that key.`;
      return;
    }
    try {
      this.storageOut.textContent = `JSON.parse(localStorage.getItem("${key}")) →\n${JSON.stringify(JSON.parse(raw), null, 2)}`;
    } catch (error) {
      this.storageOut.dataset.error = "true";
      this.storageOut.textContent = `JSON.parse(localStorage.getItem("${key}")) throws\n${error.message}\nThe stored text was: ${raw}`;
    }
  }

  drop() {
    this.storage = removeItem(this.storage, this.key.value.trim());
    this.storageOut.textContent = `localStorage.removeItem("${this.key.value.trim()}")`;
    this.renderStorage();
  }

  empty() {
    this.storage = clear(this.storage);
    this.storageOut.textContent = "localStorage.clear()";
    this.renderStorage();
  }

  // ---- Lesson scenarios (fence option lesson="login|caching|testing") --------------------

  setupScenario(scenario) {
    const kind = this.dataset.lesson;
    this.kind = kind;
    this.append(el("p", { class: "ob-fetch-note" }, scenario.note));
    if (kind === "testing") { this.buildTesting(scenario); return; }
    this.world = createWorld();
    this.append(this.buildScenarioRequest(scenario), this.buildPipeline(STAGES.slice(0, 3)), this.buildResult(),
      this.buildWorld());
    this.pick(scenario.presets[0]);
    this.renderWorld();
  }

  buildScenarioRequest(scenario) {
    const login = this.kind === "login";
    const box = el("section", { class: "ob-fetch-panel", "aria-label": "Request" });
    const row = el("div", { class: "ob-fetch-presets", role: "group", "aria-label": "Example requests" });
    for (const preset of scenario.presets) {
      const button = el("button", { type: "button" }, preset.label);
      button.addEventListener("click", () => { this.pick(preset); this.sendScenario(); });
      row.append(button);
    }
    this.explain = el("p", { class: "ob-fetch-explain", role: "status" });
    this.method = el("select");
    for (const verb of ["GET", "POST"]) this.method.append(el("option", { value: verb }, verb));
    this.path = el("input", { type: "text", autocomplete: "off", spellcheck: "false" });
    this.headers = el("textarea", { rows: "2", spellcheck: "false", placeholder: "Content-Type: application/json" });
    this.body = el("textarea", { rows: "2", spellcheck: "false", placeholder: '{"user": "mika", "password": "pw"}' });
    const form = el("form", { class: "ob-fetch-form" });
    form.append(field("Method", this.method), field("URL", this.path));
    if (login) {
      this.credentials = el("select");
      for (const value of CREDENTIALS) this.credentials.append(el("option", { value }, value));
      this.allowOrigin = el("select");
      for (const [value, text] of [["none", "(not sent)"], ["*", "*"], [APP_ORIGIN, APP_ORIGIN]]) {
        this.allowOrigin.append(el("option", { value }, text));
      }
      this.allowCredentials = el("input", { type: "checkbox" });
      const check = el("label", { class: "ob-fetch-check" });
      check.append(this.allowCredentials, " Server sends Access-Control-Allow-Credentials: true");
      form.append(field("credentials option", this.credentials),
        field("Server sends Access-Control-Allow-Origin (applies to cross-origin URLs)", this.allowOrigin), check,
        field("Headers (Name: value, one per line)", this.headers), field("Body", this.body));
    }
    form.append(el("button", { type: "submit" }, "Send request"));
    form.addEventListener("submit", (event) => { event.preventDefault(); this.sendScenario(); });
    form.addEventListener("input", () => this.showSnippet());
    this.snippet = el("pre", { class: "ob-fetch-code", tabindex: "0", "aria-label": "Equivalent fetch code" });
    box.append(row, this.explain, form, this.snippet);
    return box;
  }

  pick(preset) {
    this.method.value = preset.method;
    this.path.value = preset.path;
    this.headers.value = preset.headers ?? "";
    this.body.value = preset.body ?? "";
    if (this.credentials) {
      this.credentials.value = preset.credentials ?? "same-origin";
      const server = { ...serverDefaults, ...(preset.server ?? {}) };
      this.allowOrigin.value = server.allowOrigin;
      this.allowCredentials.checked = server.allowCredentials;
    }
    this.explain.textContent = preset.explain;
    this.showSnippet();
  }

  buildWorld() {
    // Read the field into a local before an object literal uses it: the components' guard against
    // assigning host fields reads a comparison placed straight after a key as an assignment.
    const login = this.kind === "login";
    const box = el("section", { class: "ob-fetch-panel", "aria-label": login ? "Cookie jar" : "Cache and clock" });
    this.worldView = el("div", { class: "ob-fetch-world", role: "status" });
    const actions = el("div", { class: "ob-fetch-actions" });
    const buttons = login
      ? [["Clear cookies", () => { this.world = clearCookies(this.world); }]]
      : [
        ["Advance the clock 30 seconds", () => { this.world = advance(this.world, 30); }],
        ["Change the report on the server", () => { this.world = changeReport(this.world); }],
        ["Clear the cache", () => { this.world = clearCache(this.world); }],
      ];
    for (const [text, run] of buttons) {
      const button = el("button", { type: "button" }, text);
      button.addEventListener("click", () => { run(); this.renderWorld(); });
      actions.append(button);
    }
    box.append(el("h3", {}, this.kind === "login" ? "Pretend cookie jar" : "Pretend cache and clock"), this.worldView, actions);
    return box;
  }

  renderWorld() {
    const { world } = this;
    if (this.kind === "login") {
      this.worldView.textContent = world.cookie
        ? `Cookie for api.example.test: ${world.cookie} (HttpOnly, invisible to your JavaScript)`
        : "Cookie for api.example.test: (none)";
      return;
    }
    const entries = cacheEntries(world);
    const lines = [
      `Pretend clock: ${world.now} s`,
      `Requests that reached the server: ${world.serverHits}`,
      `Server's current ETag for /report: "v${world.reportVersion}"`,
      ...(entries.length
        ? entries.map((entry) => `Saved copy of ${entry.key}: ETag ${entry.etag}, ${entry.age} s old, ${entry.fresh ? "fresh" : "stale"}`)
        : ["Saved copies: (none)"]),
    ];
    this.worldView.textContent = lines.join("\n");
  }

  sendScenario() {
    const request = this.current();
    if (this.credentials) {
      request.credentials = this.credentials.value;
      request.server = { allowOrigin: this.allowOrigin.value, allowCredentials: this.allowCredentials.checked };
    }
    const result = exchange(this.world, request);
    this.world = result.world;
    this.showExchange(result);
    this.renderWorld();
  }

  showExchange(result) {
    const { wire, response, blocked, source, ok, json, lessons, sent, cookieSent } = result;
    const set = (key, state) => { if (state) this.stages[key].dataset.state = state; else delete this.stages[key].dataset.state; };
    set("request", "done");
    const notes = [];
    if (source === "cache") notes.push("Answered from the cache: no request left the browser.");
    if (source === "revalidated") notes.push("Revalidated: the server said 304 and the browser reused its copy.");
    if (source === "network" && wire) notes.push("Answered by the server.");
    if (blocked) notes.push("The browser blocked the response.");
    if (this.kind === "login") notes.push(`Cookie sent: ${cookieSent ? "yes" : "no"}.`);
    if (sent?.["if-none-match"]) notes.push(`Sent If-None-Match: ${sent["if-none-match"]}.`);
    const shown = wire ?? response;
    this.responseView.textContent = shown
      ? `${source === "cache" ? "(no request was sent; this is the saved copy)\n" : ""}HTTP ${shown.status} ${shown.statusText}\n${Object.entries(shown.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${shown.body || "(no body)"}`
      : "(no response: the request never reached a server)";
    if (!response) {
      this.codeView.textContent = "await fetch(…) rejected\nTypeError: Failed to fetch";
      set("response", "error"); set("parse", "");
    } else {
      this.codeView.textContent = [
        `response.status  → ${response.status}`,
        `response.ok      → ${ok}`,
        json.ok ? `await response.json() → ${JSON.stringify(json.value)}` : `await response.json() → throws SyntaxError\n  ${json.error}`,
      ].join("\n");
      set("response", ok ? "done" : "error"); set("parse", json.ok ? "done" : "error");
    }
    this.lessons.textContent = `${notes.join(" ")} ${lessons.join(" ")}`.trim();
  }

  buildTesting(scenario) {
    const box = el("section", { class: "ob-fetch-panel", "aria-label": "Stub" });
    box.append(el("h3", {}, "Function under test"), el("pre", { class: "ob-fetch-code", tabindex: "0", "aria-label": "Function under test" }, functionUnderTest));
    const row = el("div", { class: "ob-fetch-presets", role: "group", "aria-label": "Example stubs" });
    for (const preset of scenario.presets) {
      const button = el("button", { type: "button" }, preset.label);
      button.addEventListener("click", () => { this.fill(preset); this.run(); });
      row.append(button);
    }
    this.explain = el("p", { class: "ob-fetch-explain", role: "status" });
    this.stubKind = el("select");
    for (const [value, text] of [["response", "Answers with a response"], ["network", "Network error (rejects)"], ["slow", "Answers slowly"]]) {
      this.stubKind.append(el("option", { value }, text));
    }
    this.stubStatus = el("input", { type: "text", inputmode: "numeric", autocomplete: "off" });
    this.stubDelay = el("input", { type: "text", inputmode: "numeric", autocomplete: "off" });
    this.stubBody = el("textarea", { rows: "2", spellcheck: "false" });
    const form = el("form", { class: "ob-fetch-form" });
    form.append(field("Stub behavior", this.stubKind), field("Status", this.stubStatus),
      field("Body", this.stubBody), field("Delay in milliseconds (for \"Answers slowly\")", this.stubDelay),
      el("button", { type: "submit" }, "Run the function"));
    form.addEventListener("submit", (event) => { event.preventDefault(); this.run(); });
    box.append(el("h3", {}, "Replace fetch with a stub"), row, this.explain, form);

    const result = el("div", { class: "ob-fetch-result" });
    this.testOut = el("pre", { class: "ob-fetch-out", tabindex: "0", role: "status", "aria-label": "Result" });
    this.testCalls = el("pre", { class: "ob-fetch-out", tabindex: "0", "aria-label": "What happened" });
    this.lessons = el("p", { class: "ob-fetch-lesson" });
    const left = el("section", { class: "ob-fetch-panel" });
    left.append(el("h3", {}, "What the function did"), this.testOut, this.testCalls, this.lessons);
    this.testCode = el("pre", { class: "ob-fetch-code", tabindex: "0", "aria-label": "Test code for this stub" });
    const right = el("section", { class: "ob-fetch-panel" });
    right.append(el("h3", {}, "The same stub as test code"), this.testCode);
    result.append(left, right);
    this.append(box, result);
    this.fill(scenario.presets[0]);
    this.run();
  }

  fill(preset) {
    this.stubKind.value = preset.kind;
    this.stubStatus.value = String(preset.status || "");
    this.stubDelay.value = String(preset.delay ?? "");
    this.stubBody.value = preset.body ?? "";
    this.explain.textContent = preset.explain;
  }

  run() {
    const stub = { kind: this.stubKind.value, status: this.stubStatus.value, body: this.stubBody.value, delay: this.stubDelay.value };
    const outcome = runUnderTest(stub);
    this.testOut.textContent = outcome.outcome === "returns"
      ? `getPostTitle(stub, 1) returned ${JSON.stringify(outcome.value) ?? "undefined"}`
      : `getPostTitle(stub, 1) threw ${outcome.error.name}: ${outcome.error.message}`;
    this.testOut.dataset.error = String(outcome.outcome !== "returns");
    this.testCalls.textContent = outcome.calls.join("\n");
    this.lessons.textContent = outcome.lessons.join(" ");
    this.testCode.textContent = testSnippet(stub);
  }

  renderStorage() {
    const used = usage(this.storage);
    this.meter.value = used;
    this.meterText.textContent = ` ${used} / ${this.storage.quota} characters`;
    const entries = Object.entries(this.storage.items);
    this.items.replaceChildren(...(entries.length
      ? entries.map(([key, value]) => el("li", {}, `${key} = ${value}`))
      : [el("li", { class: "ob-fetch-empty" }, "(empty)")]));
  }
}

defineLab("ob-fetch-lab", ObFetchLab);
