// The Business facts screen (ADR 0307, #508): the pure contract (phone, hours, validation, the stored
// shape) and the screen against a fake server, so every rule here is the rule the server applies.
import assert from "node:assert/strict";
import test from "node:test";

import {
  WEEKDAYS,
  businessErrorText,
  businessFromForm,
  copyDay,
  createBusinessFacts,
  formFromBusiness,
  formatPhone,
  normalizePhone,
  sameBusiness,
  validateForm,
} from "../../web/admin/business.js";
import { ApiError, choose, tick, type, withDom } from "./dom-shim.mjs";

const named = (root, name) => root.querySelectorAll("input, select").find((node) => node.attributes.name === name);
const problemFor = (root, key) => root.querySelectorAll("p").find((p) => p.dataset.problemFor === key);
const text = (node) => node.textContent.replace(/\s+/g, " ").trim();

const STORED = {
  version: 1,
  displayName: "Maple Falls Flooring",
  trade: "flooring",
  phone: "+13605550142",
  hours: { monday: { open: "08:00", close: "17:00" }, sunday: { closed: true } },
  insured: true,
  paymentMethods: ["cash"],
  foundedYear: 1998,
  "x-future": { keep: 1 },
};

function server(initial = {}) {
  const state = { business: structuredClone(STORED), etag: "e1", ...initial };
  return {
    state,
    calls: [],
    next: null,
    async call(method, path, options = {}) {
      this.calls.push({ method, path, body: options.json });
      if (this.next) {
        const failure = this.next;
        this.next = null;
        throw failure;
      }
      const described = () => ({
        business: structuredClone(state.business),
        etag: state.etag,
        problems: [],
        trades: ["flooring", "plumbing", "other"],
        weekdays: WEEKDAYS.map(([id, label]) => ({ id, label })),
      });
      if (method === "GET") return described();
      state.business = { version: 1, ...options.json.business };
      if (state.business.phone) state.business.phone = normalizePhone(state.business.phone);
      state.etag = `e${this.calls.length}`;
      return { ...described(), buildError: null };
    },
  };
}

async function mount(api) {
  const view = createBusinessFacts({ api });
  document.body.append(view.element);
  await view.load();
  await tick();
  return { view, root: view.element };
}

// ----- the pure contract ----------------------------------------------------

test("a typed phone becomes E.164 and is shown the way a person reads it", () => {
  assert.equal(normalizePhone("(360) 555-0142"), "+13605550142");
  assert.equal(normalizePhone("1-360-555-0142"), "+13605550142");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("  "), "");
  assert.equal(normalizePhone("call me"), "call me");
  assert.equal(formatPhone("+13605550142"), "(360) 555-0142");
  assert.equal(formatPhone("+442079460958"), "+442079460958");
});

test("a stored block round-trips through the form without losing or inventing anything", () => {
  const form = formFromBusiness(STORED);
  assert.equal(form.hours.monday.mode, "open");
  assert.equal(form.hours.sunday.mode, "closed");
  assert.equal(form.hours.tuesday.mode, "unset");
  const back = businessFromForm(form);
  const { version, "x-future": future, ...known } = STORED;
  void version;
  void future;
  assert.deepEqual(back, known);
  assert.deepEqual(businessFromForm(formFromBusiness({})), {});
  assert.deepEqual(businessFromForm(formFromBusiness(null)), {});
});

test("open all day is the stored 00:00 to 24:00 and comes back as itself", () => {
  const form = formFromBusiness({ hours: { saturday: { open: "00:00", close: "24:00" } } });
  assert.equal(form.hours.saturday.mode, "allday");
  assert.deepEqual(businessFromForm(form).hours, { saturday: { open: "00:00", close: "24:00" } });
});

test("problems are plain, named by field and day, and match the server's rules", () => {
  const form = formFromBusiness({});
  Object.assign(form, { phone: "call us", email: "nope", foundedYear: "1066", licenseIssuer: "State", licenseNumber: "" });
  form.hours.monday = { mode: "open", open: "18:00", close: "09:00" };
  form.hours.tuesday = { mode: "open", open: "", close: "17:00" };
  const problems = validateForm(form);
  const fields = problems.map((p) => p.field);
  assert.deepEqual([...new Set(fields)].sort(), ["email", "foundedYear", "hours", "licenseIssuer", "phone"]);
  assert.equal(problems.find((p) => p.day === "monday").message, "Monday: closing time must be after the opening time. For a day that runs all night, choose Open 24 hours.");
  assert.match(problems.find((p) => p.day === "tuesday").message, /choose both an opening and a closing time/);
  for (const problem of problems) assert.ok(!/[<>]|undefined|null/.test(problem.message), problem.message);
  assert.deepEqual(validateForm(formFromBusiness(STORED)), []);
  assert.deepEqual(validateForm({ ...formFromBusiness({}), phone: "(360) 555-0142" }), []);
});

test("copying a day sets the others without touching the rest", () => {
  const form = formFromBusiness(STORED);
  const copied = copyDay(form, "monday", ["tuesday", "friday"]);
  assert.deepEqual(copied.hours.tuesday, form.hours.monday);
  assert.equal(copied.hours.sunday.mode, "closed");
  assert.equal(copied.hours.wednesday.mode, "unset");
  assert.ok(!sameBusiness(form, copied));
  assert.ok(sameBusiness(form, formFromBusiness(STORED)));
});

test("error words say what to do and never pass a server's markup through as more than text", () => {
  assert.match(businessErrorText({ status: 409 }), /Reload them/);
  assert.match(businessErrorText({ status: 413 }), /too much/);
  assert.match(businessErrorText({ status: 500, message: "Boom" }), /not saved\. Boom/);
  assert.match(businessErrorText({}), /Check your connection/);
});

// ----- the screen -------------------------------------------------------------

test("the screen shows every fact with a real label, one control per day, and what is stored", withDom(async () => {
  const { root } = await mount(server());
  assert.equal(named(root, "displayName").value, "Maple Falls Flooring");
  assert.equal(named(root, "phone").value, "+13605550142");
  assert.equal(named(root, "trade").value, "flooring");
  assert.equal(named(root, "foundedYear").value, "1998");
  assert.equal(named(root, "insured").checked, true);
  assert.equal(root.querySelectorAll("input").filter((i) => i.attributes.name === "paymentMethods").length, 7);
  assert.equal(root.querySelectorAll("fieldset").filter((f) => f.dataset.businessDay).length, 7);
  assert.equal(named(root, "hours-monday").value, "open");
  assert.equal(named(root, "hours-sunday").value, "closed");
  // Every input has a label that points at it.
  const labels = new Set(root.querySelectorAll("label").map((l) => l.attributes.for));
  for (const control of root.querySelectorAll("input, select")) assert.ok(labels.has(control.id), `${control.attributes.name} has a label`);
  // The Monday times show; the closed Sunday has none.
  const monday = root.querySelectorAll("fieldset").find((f) => f.dataset.businessDay === "monday");
  const sunday = root.querySelectorAll("fieldset").find((f) => f.dataset.businessDay === "sunday");
  assert.equal(monday.querySelectorAll("div").find((d) => d.className === "oba-business-times").hidden, false);
  assert.equal(sunday.querySelectorAll("div").find((d) => d.className === "oba-business-times").hidden, true);
}));

test("a bad phone and a backwards day are said beside their fields and nothing is sent", withDom(async () => {
  const api = server({ business: {} });
  const { root, view } = await mount(api);
  await type(named(root, "phone"), "call us");
  await choose(named(root, "hours-monday"), "open");
  await type(root.querySelectorAll("input").find((i) => i.dataset.day === "monday" && i.dataset.which === "open"), "18:00");
  await type(root.querySelectorAll("input").find((i) => i.dataset.day === "monday" && i.dataset.which === "close"), "09:00");
  assert.equal(await view.save(), false);
  assert.equal(api.calls.filter((c) => c.method === "PUT").length, 0);
  assert.match(text(problemFor(root, "phone")), /country code/);
  assert.equal(problemFor(root, "phone").hidden, false);
  assert.equal(named(root, "phone").attributes["aria-invalid"], "true");
  assert.match(text(problemFor(root, "hours-monday")), /Monday: closing time must be after/);
  assert.match(text(root.querySelectorAll("p").find((p) => p.dataset.businessStatus)), /2 things need fixing/);
  // Fixing the phone and the day clears the messages and sends one request.
  await type(named(root, "phone"), "(360) 555-0142");
  await type(root.querySelectorAll("input").find((i) => i.dataset.day === "monday" && i.dataset.which === "open"), "08:00");
  await type(root.querySelectorAll("input").find((i) => i.dataset.day === "monday" && i.dataset.which === "close"), "17:00");
  assert.equal(await view.save(), true);
  const sent = api.calls.find((c) => c.method === "PUT");
  assert.equal(sent.body.etag, "e1");
  assert.deepEqual(sent.body.business, { phone: "+13605550142", hours: { monday: { open: "08:00", close: "17:00" } } });
  assert.equal(problemFor(root, "phone").hidden, true);
}));

test("a save sends only what is stated, in the stored shape, and shows the stored phone after", withDom(async () => {
  const api = server();
  const { root, view } = await mount(api);
  await type(named(root, "phone"), "(360) 555-0199");
  await choose(named(root, "hours-tuesday"), "closed");
  assert.equal(view.isDirty(), true);
  assert.equal(await view.save(), true);
  const sent = api.calls.find((c) => c.method === "PUT");
  assert.deepEqual(sent.body.business, {
    displayName: "Maple Falls Flooring",
    trade: "flooring",
    phone: "+13605550199",
    hours: { monday: { open: "08:00", close: "17:00" }, tuesday: { closed: true }, sunday: { closed: true } },
    insured: true,
    paymentMethods: ["cash"],
    foundedYear: 1998,
  });
  assert.equal(named(root, "phone").value, "+13605550199");
  assert.equal(view.isDirty(), false);
  assert.match(text(root.querySelectorAll("p").find((p) => p.dataset.businessStatus)), /^Saved\./);
}));

test("the server's problems land beside the right field and the owner's edits stay", withDom(async () => {
  const api = server();
  const { root, view } = await mount(api);
  await type(named(root, "email"), "office@example.com");
  api.next = new ApiError("x", 422, { error: "email must be one address", problems: [{ field: "email", message: "email must be one address, like office@example.com" }, { field: "hours", day: "monday", message: "hours: Monday open must be a time" }] });
  assert.equal(await view.save(), false);
  assert.match(text(problemFor(root, "email")), /email must be one address/);
  assert.match(text(problemFor(root, "hours-monday")), /Monday open/);
  assert.equal(named(root, "email").value, "office@example.com");
  assert.equal(view.isDirty(), true);
}));

test("a conflict keeps the edits, says why, and offers to reload", withDom(async () => {
  const api = server();
  const { root, view } = await mount(api);
  await type(named(root, "displayName"), "Changed");
  api.next = new ApiError("conflict", 409, { error: "changed" });
  assert.equal(await view.save(), false);
  const box = root.querySelectorAll("div").find((d) => d.dataset.businessConflict);
  assert.equal(box.hidden, false);
  assert.equal(named(root, "displayName").value, "Changed");
  api.state.business.displayName = "Elsewhere";
  api.state.etag = "e9";
  const reload = box.querySelectorAll("button").find((b) => b.dataset.action === "business-reload");
  await reload.dispatch("click");
  await tick();
  assert.equal(named(root, "displayName").value, "Elsewhere");
  assert.equal(box.hidden, true);
}));

test("copy Monday fills Tuesday to Friday and says it is not saved", withDom(async () => {
  const { root } = await mount(server());
  const copy = root.querySelectorAll("button").find((b) => b.dataset.action === "business-copy-monday");
  await copy.dispatch("click");
  assert.equal(named(root, "hours-friday").value, "open");
  assert.equal(named(root, "hours-saturday").value, "unset");
  assert.match(text(root.querySelectorAll("p").find((p) => p.dataset.businessStatus)), /Not saved yet/);
}));

test("a stored block with a problem is shown with the problem so it can be fixed", withDom(async () => {
  const api = server();
  api.call = async function call() {
    return { business: { phone: "555" }, etag: "z", problems: [{ field: "phone", message: "phone must include the country code" }], trades: [], weekdays: [] };
  };
  const { root } = await mount(api);
  assert.match(text(problemFor(root, "phone")), /country code/);
  assert.equal(named(root, "phone").value, "555");
}));
