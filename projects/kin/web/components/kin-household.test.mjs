import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.isConnected = true;
    this.textContent = "";
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  toggleAttribute(name, enabled) {
    if (enabled) this.attributes[name] = "";
    else delete this.attributes[name];
    return enabled;
  }
  querySelector(selector) {
    return selector === ".household-message"
      ? this.children.find((child) => child.className === "household-message") ?? null
      : null;
  }
  querySelectorAll(selector) {
    const tags = new Set(selector.split(",").map((value) => value.trim()));
    const descendants = (children) =>
      children.flatMap((child) => [child, ...descendants(child.children ?? [])]);
    return descendants(this.children).filter((child) => tags.has(child.tagName));
  }
}

globalThis.HTMLElement = class extends ElementStub {};
globalThis.customElements = { define: (_name, component) => { globalThis.KinHouseholdUnderTest = component; } };
globalThis.document = {
  createElement: (tagName) => new ElementStub(tagName),
  createTextNode: (text) => ({ textContent: text }),
};
await import("./kin-household.js");
const KinHousehold = globalThis.KinHouseholdUnderTest;

test("busy-state changes preserve controls gated by a local prerequisite", () => {
  const component = new KinHousehold();
  const gated = document.createElement("button");
  const available = document.createElement("button");
  component.append(gated, available);

  component.setControlDisabled(gated, true);
  assert.equal(gated.hasAttribute("data-gated"), true);
  component.disabled = true;
  assert.equal(gated.disabled, true);
  assert.equal(available.disabled, true);

  component.disabled = false;
  assert.equal(gated.disabled, true, "the prerequisite still gates its control");
  assert.equal(available.disabled, false, "the busy-only control becomes available");

  component.setControlDisabled(gated, false);
  assert.equal(gated.disabled, false);
  assert.equal(gated.hasAttribute("data-gated"), false);
});

test("Limited and Temporary members get a clearly named Leave household button", async () => {
  for (const kind of ["limited", "temporary"]) {
    const component = new KinHousehold();
    component.identity = { memberId: "current-member" };
    component.run = async (action) => action();
    component.api = async () => ({
      members: [{ id: "current-member", current: true, active: true, kind, expiresAt: Date.now() + 60_000 }],
    });
    await component.showHousehold();
    const buttons = component.children.filter((child) => child.tagName === "button");
    assert.ok(buttons.some((button) => button.textContent === "Leave household"));
    const leave = buttons.find((button) => button.textContent === "Leave household");
    assert.equal(leave.type, "button");
    assert.equal(buttons.some((button) => button.textContent === "Delete household"), false);
  }
});

test("only Adults can see Enable device sync while other members get participation guidance", () => {
  for (const kind of ["limited", "temporary"]) {
    const component = new KinHousehold();
    component.syncStatus = { memberKind: kind, enabled: false };
    component.renderMember();
    assert.equal(component.children.some((child) => child.textContent === "Enable device sync"), false);
    assert.ok(component.children.some((child) => child.textContent.includes("Ask a household Adult to enable it")));
  }
  const adult = new KinHousehold();
  adult.syncStatus = { memberKind: "adult", enabled: false };
  adult.renderMember();
  assert.ok(adult.children.some((child) => child.textContent === "Enable device sync"));
});

test("device revocation control names its target", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "adult", deviceId: "self" };
  component.syncKeyError = "skip sync-key access";
  component.run = async (action) => action();
  component.api = async () => ({ canManageMembers: true, devices: [
    { id: "self", label: "Adult phone", revokedAt: null },
    { id: "other", label: "Kitchen tablet", revokedAt: null },
  ] });
  await component.showDevices();
  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const revoke = descendants(component.children).find((child) => child.textContent?.startsWith("Revoke "));
  assert.equal(revoke.textContent, "Revoke Kitchen tablet");
});

test("device trust refuses a forced click until its displayed code is confirmed", async () => {
  const component = new KinHousehold();
  component.identity = {
    householdId: "household",
    memberId: "adult",
    deviceId: "current-device",
  };
  component.assertConnection = () => {};
  const expected = {
    householdId: "household",
    memberId: "partner",
    deviceId: "partner-device",
    publicKeys: { encryption: "key" },
    fingerprint: "a".repeat(64),
  };
  const pinned = [];
  component.syncKeyStore = {
    getPinnedDevice: async () => null,
    pinTrustedDevice: async (value) => pinned.push(value),
  };
  component.ctx.api.openSyncKeyStore = async () => {};
  component.ctx.api.requestSync = () => {};
  component.api = async (path) => {
    if (path === "/api/devices")
      return {
        canManageMembers: false,
        devices: [
          {
            id: "partner-device",
            memberId: "partner",
            label: "Partner phone",
            revokedAt: null,
          },
        ],
      };
    if (path === "/api/sync/devices")
      return {
        devices: [
          {
            memberId: expected.memberId,
            deviceId: expected.deviceId,
            publicKeys: expected.publicKeys,
            fingerprint: expected.fingerprint,
          },
        ],
      };
    throw new Error(`Unexpected API path: ${path}`);
  };

  await component.showDevices();
  const descendants = (items) =>
    items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const verify = descendants(component.children).find(
    (child) => child.textContent === "Verify device",
  );
  verify.listeners.click();
  const confirmation = descendants(component.children).find(
    (child) => child.tagName === "input" && child.type === "checkbox",
  );
  const trust = descendants(component.children).find(
    (child) => child.textContent === "Trust this device",
  );

  trust.disabled = false;
  await trust.listeners.click();
  assert.equal(pinned.length, 0);
  const refusal = component.children.find(
    (child) => child.className === "household-message",
  );
  assert.equal(refusal.attributes.role, "alert");
  assert.equal(
    refusal.textContent,
    "Compare the codes on both devices before trusting this device.",
  );

  confirmation.checked = true;
  await trust.listeners.click();
  assert.deepEqual(pinned, [expected]);
});

test("self-leave requests a passkey and cancellation leaves local authority intact", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "limited-member" };
  component.assertConnection = () => {};
  let finishCalls = 0;
  component.api = async (path) => {
    assert.equal(path, "/api/household/membership/remove/options");
    return { flow: "flow", publicKey: { challenge: "YQ", allowCredentials: [] } };
  };
  globalThis.confirm = (copy) => {
    assert.match(copy, /Leave this household/);
    assert.doesNotMatch(copy, /adult/i);
    return true;
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { credentials: { get: async () => { throw new DOMException("Cancelled", "NotAllowedError"); } } },
  });
  const originalApi = component.api;
  component.api = async (...args) => {
    if (args[0] === "/api/household/membership/remove/finish") finishCalls += 1;
    return originalApi(...args);
  };
  await component.leave();
  assert.equal(finishCalls, 0);
  assert.equal(component.identity.memberId, "limited-member");
  assert.equal(component.children.some((child) => child.type === "button"), false);
  const status = component.children.find((child) => child.className === "household-message");
  assert.equal(status.attributes.role, "alert");
  assert.match(status.textContent, /request was cancelled\. No authorization change was made\./);
});

test("successful self-leave completes the passkey mutation before local lock and navigation", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "temporary-member" };
  component.assertConnection = () => {};
  const calls = [];
  component.api = async (path, options) => {
    calls.push(path);
    if (path.endsWith("/options"))
      return { flow: "flow", publicKey: { challenge: "YQ", allowCredentials: [{ id: "Yg" }] } };
    return { removed: true };
  };
  component.message = () => {};
  component.dispatchEvent = (event) => { calls.push(event.type); };
  component.identity.memberId = "temporary-member";
  globalThis.confirm = () => true;
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  globalThis.location = { href: "" };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      credentials: {
        get: async () => ({
          id: "credential-temporary",
          type: "public-key",
          response: { clientDataJSON: new Uint8Array([1]), getTransports: () => [] },
        }),
      },
    },
  });
  await component.leave();
  assert.deepEqual(calls, [
    "/api/household/membership/remove/options",
    "/api/household/membership/remove/finish",
    "kin:lock",
  ]);
  assert.equal(component.identity, null);
  assert.equal(globalThis.location.href, "/");
});

test("device revocation refreshes the trusted-device list after the passkey operation releases the busy guard", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "adult", deviceId: "self" };
  component.syncKeyError = "skip sync-key access";
  component.assertConnection = () => {};
  let revoked = false;
  const calls = [];
  component.api = async (path) => {
    calls.push(path);
    if (path === "/api/devices")
      return { canManageMembers: true, devices: [
        { id: "self", label: "Adult phone", revokedAt: null },
        { id: "other", label: "Kitchen tablet", revokedAt: revoked ? 1_700_000_000_000 : null },
      ] };
    if (path === "/api/devices/other/revocation/options")
      return { flow: "flow", publicKey: { challenge: "YQ", allowCredentials: [{ id: "Yg" }] } };
    if (path === "/api/devices/revocation/finish") { revoked = true; return { revoked: true }; }
    throw new Error("unexpected call " + path);
  };
  globalThis.confirm = () => true;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { credentials: { get: async () => ({
      id: "credential-adult", type: "public-key",
      response: { clientDataJSON: new Uint8Array([1]), getTransports: () => [] },
    }) } },
  });
  await component.showDevices();
  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const revoke = descendants(component.children).find((child) => child.textContent === "Revoke Kitchen tablet");
  await revoke.listeners.click();
  // An admin's People & devices also lists the invitations they set up for
  // someone (#613); a failed list just leaves that section out.
  assert.deepEqual(calls, [
    "/api/devices",
    "/api/pairings/prepared",
    "/api/devices/other/revocation/options",
    "/api/devices/revocation/finish",
    "/api/devices",
    "/api/pairings/prepared",
  ]);
  const labels = descendants(component.children).map((child) => child.textContent);
  const row = descendants(component.children).find((child) => child.dataset?.deviceId === "other");
  const line = row.children.find((child) => child.className === "device-name-line");
  assert.equal(line.children.map((part) => part.textContent ?? part).join(""), "Kitchen tablet — Revoked",
    "list shows the revoked device after refresh");
  assert.equal(labels.some((label) => label === "Revoke Kitchen tablet"), false, "revoked device offers no further revoke control");
  assert.equal(component.busy, false);
});

// After a move (ADR 0026 §6, #769): your old laptop and Sam's phone came
// from the old address. Only this device is pinned here, so a fall-through
// to Trusted or Untrusted would show.
function movedDevicesComponent({ canManageMembers = true, carriedOver = true, others = [] } = {}) {
  const component = new KinHousehold();
  component.identity = { memberId: "adult", deviceId: "self" };
  component.localFingerprint = "SELF";
  component.assertConnection = () => {};
  let removed = false;
  const calls = [];
  component.ctx.api.openSyncKeyStore = async () => component.syncKeyStore;
  component.syncKeyStore = { getPinnedDevice: async (_householdId, deviceId) => deviceId === "self" };
  component.api = async (path) => {
    calls.push(path);
    if (path === "/api/devices")
      return { canManageMembers, devices: [
        { id: "self", memberId: "adult", label: "Adult phone", revokedAt: null, carriedOver: false },
        { id: "old-laptop", memberId: "adult", label: "Adult laptop", revokedAt: removed ? 1 : null, ...(carriedOver ? { carriedOver: !removed } : {}) },
        { id: "sam-phone", memberId: "sam", label: "Sam phone", revokedAt: removed ? 1 : null, ...(carriedOver ? { carriedOver: !removed } : {}) },
        ...others,
      ] };
    if (path === "/api/sync/devices")
      return { devices: [
        { deviceId: "self", memberId: "adult", fingerprint: "SELF", publicKeys: {} },
        { deviceId: "old-laptop", memberId: "adult", fingerprint: "AAAA1111", publicKeys: {} },
        { deviceId: "sam-phone", memberId: "sam", fingerprint: "BBBB2222", publicKeys: {} },
      ] };
    if (path === "/api/pairings/prepared") return { pairings: [] };
    if (path === "/api/devices/carried-over/revocation/options")
      return { flow: "flow", devices: 2, publicKey: { challenge: "YQ", allowCredentials: [{ id: "Yg" }] } };
    if (path === "/api/devices/carried-over/revocation/finish") { removed = true; return { revoked: ["old-laptop", "sam-phone"], revokedAt: 1 }; }
    throw new Error("unexpected call " + path);
  };
  return { component, calls };
}

test("devices from the old address are marked and removed together by an admin", async () => {
  const { component, calls } = movedDevicesComponent();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { credentials: { get: async () => ({
      id: "credential-adult", type: "public-key",
      response: { clientDataJSON: new Uint8Array([1]), getTransports: () => [] },
    }) } },
  });
  await component.showDevices();
  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const line = (id) => descendants(component.children).find((child) => child.dataset?.deviceId === id)
    .children.find((child) => child.className === "device-name-line").children.map((part) => part.textContent ?? part).join("");
  assert.equal(line("old-laptop"), "Adult laptop — From the old address · can't sign in here");
  assert.equal(line("sam-phone"), "Sam phone — From the old address · can't sign in here");
  const labels = () => descendants(component.children).filter((child) => child.tagName === "button").map((button) => button.textContent);
  assert.equal(labels().includes("Verify device"), false, "nothing to compare codes with");
  assert.equal(labels().includes("Replace this device"), false);
  assert.ok(labels().includes("Revoke Adult laptop"), "one at a time still works");

  // Cancelling asks nothing of the server.
  const asked = [];
  globalThis.confirm = (text) => { asked.push(text); return false; };
  const button = () => descendants(component.children).find((child) => child.textContent === "Remove the 2 devices from the old address");
  await button().listeners.click();
  assert.equal(calls.includes("/api/devices/carried-over/revocation/options"), false);
  assert.match(asked[0], /^Remove the 2 devices from the old address\? None of them can sign in here\. Household member 1 hasn't signed in here yet\./);

  globalThis.confirm = () => true;
  calls.length = 0;
  await button().listeners.click();
  assert.deepEqual(calls.slice(0, 3), [
    "/api/devices/carried-over/revocation/options",
    "/api/devices/carried-over/revocation/finish",
    "/api/devices",
  ]);
  assert.equal(line("sam-phone"), "Sam phone — Revoked");
  assert.equal(button(), undefined, "nothing left to remove");
  assert.equal(component.busy, false);
});

test("the confirmation names only members with no device here", async () => {
  // Robin signed in here on a new device; Kit's new device was revoked, so
  // Kit, like Sam, hasn't signed in here yet.
  const { component } = movedDevicesComponent({ others: [
    { id: "robin-old", memberId: "robin", label: "Robin old phone", revokedAt: null, carriedOver: true },
    { id: "robin-new", memberId: "robin", label: "Robin new phone", revokedAt: null, carriedOver: false },
    { id: "kit-old", memberId: "kit", label: "Kit old tablet", revokedAt: null, carriedOver: true },
    { id: "kit-new", memberId: "kit", label: "Kit new tablet", revokedAt: 1, carriedOver: false },
  ] });
  await component.showDevices();
  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const titles = descendants(component.children).filter((child) => child.tagName === "h3").map((title) => title.textContent);
  assert.deepEqual(titles.slice(0, 4), ["You", "Household member 1", "Household member 2", "Household member 3"]);
  const asked = [];
  globalThis.confirm = (text) => { asked.push(text); return false; };
  await descendants(component.children).find((child) => child.textContent === "Remove the 4 devices from the old address").listeners.click();
  assert.match(asked[0], /None of them can sign in here\. Household member 1 and Household member 3 haven't signed in here yet\./);
});

test("the remove-together section has a heading of its own", async () => {
  const { component } = movedDevicesComponent();
  await component.showDevices();
  const section = component.children.find((child) => child.className === "carried-over-devices");
  const heading = section.children[0];
  assert.equal(heading.tagName, "h3");
  assert.equal(heading.textContent, "Devices from the old address");
  assert.equal(section.attributes["aria-labelledby"], heading.id);
});

test("the remove-together button fails closed", async () => {
  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const offers = async (component) => {
    await component.showDevices();
    return descendants(component.children).some((child) => child.textContent?.startsWith?.("Remove the 2 devices"));
  };
  assert.equal(await offers(movedDevicesComponent({ canManageMembers: false }).component), false, "without management authority");
  assert.equal(await offers(movedDevicesComponent({ canManageMembers: "true" }).component), false, "a truthy non-boolean");
  assert.equal(await offers(movedDevicesComponent({ carriedOver: false }).component), false, "an older server marks nothing");
  const offline = movedDevicesComponent();
  assert.equal(await offers(offline.component), true);
  offline.component.api = async () => { throw Object.assign(new Error("offline"), { code: "connection_unavailable" }); };
  assert.equal(await offers(offline.component), false, "the copy saved on this device");
});

test("household admins see admin, invitation, and removal controls; other Adults do not", async () => {
  const members = (currentAdmin) => [
    { id: "founder", current: currentAdmin, active: true, kind: "adult", admin: true },
    { id: "partner", current: !currentAdmin, active: true, kind: "adult", admin: false },
    { id: "child", current: false, active: true, kind: "limited", admin: false },
  ];
  const render = async (currentAdmin) => {
    const component = new KinHousehold();
    component.identity = { memberId: currentAdmin ? "founder" : "partner" };
    component.run = async (action) => action();
    component.api = async () => ({ adminRecorded: true, canManageMembers: currentAdmin, members: members(currentAdmin) });
    await component.showHousehold();
    const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
    return descendants(component.children).filter((child) => child.tagName === "button").map((button) => button.textContent);
  };

  const admin = await render(true);
  for (const label of ["Make Adult 2 a household admin", "Remove Adult 2 from household", "Remove Limited member 1 from household",
    "Add Adult", "Add Child or Limited Member", "Add Babysitter or Guest", "Delete household"])
    assert.ok(admin.includes(label), `admin sees ${label}`);
  assert.equal(admin.includes("Stop being a household admin"), true);

  const adult = await render(false);
  for (const label of ["Add Adult", "Add Child or Limited Member", "Add Babysitter or Guest", "Delete household", "Remove Limited member 1 from household"])
    assert.equal(adult.includes(label), false, `non-admin Adult does not see ${label}`);
  assert.equal(adult.some((label) => label.includes("household admin")), false);
  assert.equal(adult.some((label) => label.startsWith("Authorize recovery for Adult 1")), false, "non-admins cannot recover an admin");
  assert.ok(adult.includes("Authorize recovery for Limited member 1"));
  assert.ok(adult.includes("Leave household"));
});

test("another member's device revocation control fails closed unless the server grants management", async () => {
  const devices = [
    { id: "self", memberId: "adult", label: "Adult phone", revokedAt: null },
    { id: "own-laptop", memberId: "adult", label: "Adult laptop", revokedAt: null },
    { id: "partner-phone", memberId: "partner", label: "Partner phone", revokedAt: null },
  ];
  const cases = [
    ["true", { canManageMembers: true }, true],
    ["false", { canManageMembers: false }, false],
    ["undefined", { canManageMembers: undefined }, false],
    ["null", { canManageMembers: null }, false],
    ["missing", {}, false],
    ["truthy non-boolean", { canManageMembers: "true" }, false],
  ];
  for (const [name, permission, othersVisible] of cases) {
    const component = new KinHousehold();
    component.identity = { memberId: "adult", deviceId: "self" };
    component.syncKeyError = "skip sync-key access";
    component.run = async (action) => action();
    component.api = async () => ({ ...permission, devices });
    await component.showDevices();
    const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
    const labels = descendants(component.children).filter((child) => child.tagName === "button").map((button) => button.textContent);
    assert.equal(labels.includes("Revoke Adult laptop"), true, `${name}: own device stays manageable`);
    assert.equal(labels.includes("Revoke Partner phone"), othersVisible, `${name}: another member's device`);
    assert.equal(labels.includes("Revoke Adult phone"), false, `${name}: the current device is never offered`);
  }
});

test("People & devices groups by stable member ID and labels people and device states (#226)", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "me", deviceId: "phone" };
  component.localFingerprint = "SELF";
  component.run = async (action) => action();
  component.ctx.api.openSyncKeyStore = async () => component.syncKeyStore;
  component.api = async (path) => path === "/api/devices"
    ? { canManageMembers: true, devices: [
      { id: "phone", memberId: "me", label: "Chrome on iPhone", revokedAt: null },
      { id: "partner-mac", memberId: "partner-a", label: "Device", revokedAt: null, syncKeyFingerprint: "abcd1234" },
      { id: "partner-tablet", memberId: "partner-b", label: "Safari on iPad", revokedAt: "now" },
      { id: "laptop", memberId: "me", label: "Firefox on Windows", revokedAt: null },
    ] }
    : { devices: [
      { deviceId: "phone", memberId: "me", fingerprint: "SELF", publicKeys: {} },
      { deviceId: "partner-mac", memberId: "partner-a", fingerprint: "ABCD1234", publicKeys: {} },
    ] };
  component.syncKeyStore = {
    getPinnedDevice: async (_householdId, deviceId) => deviceId === "phone",
  };
  const pairingActions = [];
  component.showHousehold = () => pairingActions.push(["choose-person-role"]);
  component.createPairing = (kind) => pairingActions.push(["person", kind]);
  component.createDevicePairing = () => pairingActions.push(["device"]);
  component.memberNames = { load: async () => [
    { memberId: "me", preferredName: "Alex" },
    { memberId: "partner-a", preferredName: "Alex" },
    { memberId: "partner-b", preferredName: "Riley" },
    { memberId: "pending", preferredName: "Pending person" },
  ] };
  const renamed = [];
  component.deviceNames = {
    load: async () => [
      { deviceId: "phone", memberId: "me", autoName: "Chrome on iPhone", nickname: "Kitchen phone" },
      { deviceId: "laptop", memberId: "me", autoName: "Firefox on Windows", nickname: null },
    ],
    rename: async (deviceId, nickname) => renamed.push([deviceId, nickname]),
  };
  await component.showDevices();
  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const groups = component.children.filter((child) => child.className === "device-group");
  assert.deepEqual(groups.map((group) => group.children[0].textContent), ["Alex (You)", "Alex", "Riley"]);
  assert.deepEqual(groups.map((group) => group.dataset.memberId), ["me", "partner-a", "partner-b"],
    "same display names never merge member groups and pending names do not create empty groups");
  const line = (id) => {
    const row = descendants(component.children).find((child) => child.dataset?.deviceId === id);
    return row.children.find((child) => child.className === "device-name-line").children.map((part) => part.textContent ?? part).join("");
  };
  assert.equal(line("phone"), "Kitchen phone — Chrome on iPhone · This device · Trusted");
  // Without a nickname, the owner's preferred name sits beside the automatic
  // name (#225); a nickname still wins, and an unnamed device keeps its code.
  assert.equal(line("laptop"), "Alex · Firefox on Windows — Trusted");
  assert.equal(line("partner-mac"), "New device · ABCD — Untrusted");
  assert.equal(line("partner-tablet"), "Riley · Safari on iPad — Revoked");
  const buttons = descendants(component.children).filter((child) => child.tagName === "button");
  await buttons.find((button) => button.textContent === "Invite another person").listeners.click();
  await buttons.find((button) => button.textContent === "Add my device").listeners.click();
  assert.deepEqual(pairingActions, [["choose-person-role"], ["device"]], "invitation selection must not silently create an Adult invitation");
  assert.ok(descendants(component.children).some((child) => child.textContent?.includes("own household member identity")));
  assert.ok(descendants(component.children).some((child) => child.textContent?.includes("same member identity")));
  const renameButtons = descendants(component.children).filter((child) => child.textContent === "Rename");
  assert.deepEqual(renameButtons.map((button) => button.attributes["aria-label"]), ["Rename Kitchen phone", "Rename Alex · Firefox on Windows"],
    "only your own named devices can be renamed");
  const forms = descendants(component.children).filter((child) => child.className === "device-rename-form");
  const laptopForm = forms[1];
  const laptopInput = descendants(laptopForm.children).find((child) => child.tagName === "input");
  laptopInput.value = "  Office laptop ";
  laptopForm.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(renamed, [["laptop", "Office laptop"]]);
  const remove = descendants(forms[0].children).find((child) => child.textContent === "Remove nickname");
  await remove.listeners.click();
  assert.deepEqual(renamed.at(-1), ["phone", ""]);
});

test("People & devices remains useful offline when encrypted names are unavailable (#226)", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "me", deviceId: "phone" };
  component.syncKeyError = "offline";
  component.run = async (action) => action();
  component.api = async (path) => {
    assert.equal(path, "/api/devices");
    const error = new Error("offline");
    error.code = "connection_unavailable";
    throw error;
  };
  component.memberNames = { load: async () => [
    { memberId: "me", preferredName: "Alex" },
    { memberId: "other", preferredName: "Riley" },
  ] };
  component.deviceNames = { load: async () => [
    { deviceId: "phone", memberId: "me", autoName: "Chrome on Android", nickname: null },
    { deviceId: "tablet", memberId: "other", autoName: "Safari on iPad", nickname: "Shared tablet" },
  ] };

  await component.showDevices();

  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const groups = component.children.filter((child) => child.className === "device-group");
  assert.deepEqual(groups.map((group) => group.children[0].textContent), ["Alex (You)", "Riley"]);
  const buttons = descendants(component.children).filter((child) => child.tagName === "button");
  assert.equal(buttons.some((button) => button.textContent === "Invite another person"), false,
    "inviting another person remains limited to server-authorized managers");
  assert.equal(buttons.some((button) => button.textContent === "Add my device"), true);
  const messages = descendants(component.children).filter((child) => child.className === "household-message");
  assert.ok(messages.some((message) => message.textContent.includes("connection is unavailable")));
  const deviceLines = descendants(component.children).filter((child) => child.className === "device-name-line");
  assert.deepEqual(deviceLines.map((line) => line.children.map((part) => part.textContent ?? part).join("")), [
    "Alex · Chrome on Android — This device · Status unavailable offline",
    "Shared tablet — Safari on iPad · Status unavailable offline",
  ]);
  assert.equal(buttons.some((button) => /Replace|Revoke/.test(button.textContent)), false,
    "projection-only rows never imply current remote-management authority");

  component.memberNames.load = async () => { throw new Error("projection unavailable"); };
  component.deviceNames.load = async () => { throw new Error("projection unavailable"); };
  await component.showDevices();
  const fallbackMessages = descendants(component.children).filter((child) => child.className === "household-message");
  assert.ok(fallbackMessages.some((message) => message.textContent.includes("encrypted names aren't available")));
});

test("People & devices does not mislabel server failures as offline (#226)", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "me", deviceId: "phone" };
  component.syncKeyError = "skip sync-key access";
  let rendered;
  component.run = async (action) => { try { await action(); } catch (error) { rendered = error; } };
  component.api = async () => { const error = new Error("Sign in again."); error.code = "authentication_required"; throw error; };
  await component.showDevices();
  assert.equal(rendered?.code, "authentication_required");
  assert.equal(component.children.some((child) => child.textContent?.includes("connection is unavailable")), false);

  rendered = null;
  component.api = async () => ({});
  await component.showDevices();
  assert.equal(rendered?.code, "device_list_invalid");
  assert.equal(component.children.some((child) => child.textContent?.includes("connection is unavailable")), false,
    "a malformed response is surfaced instead of using the offline fallback");
});

test("an invitation code arriving after connection fills the join screen (#97)", async () => {
  const { captureInvitationCode } = await import("../pairing-link.js");
  const calls = [];
  captureInvitationCode({ pathname: "/pair", search: "", hash: "#code=F7KM-Q2DX" }, { replaceState: (...args) => calls.push(args[2]) });
  const component = new KinHousehold();
  let renders = 0;
  component.render = () => { renders += 1; };
  component.offerInvitationCode();
  assert.equal(component.prefilledCode, "F7KM-Q2DX");
  assert.equal(renders, 1);
  assert.deepEqual(calls, ["/pair"], "the address was cleared when the code was taken");
  component.offerInvitationCode();
  assert.equal(renders, 1, "nothing more to offer");
});

// #223: a code on a different path than the one chosen is never activated
// silently, and both screens say which path is in progress.
function confirmedClaim({ intent, purpose }) {
  const component = new KinHousehold();
  component.localFingerprint = "f".repeat(64);
  component.claimIntent = intent;
  component.claim = {
    state: "Confirmed",
    purpose,
    syncKeyFingerprint: component.localFingerprint,
    inviterKeyFingerprint: "e".repeat(64),
  };
  component.ctx.views.renderJoin();
  const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
  const nodes = all(component);
  const activate = nodes.find((node) => node.tagName === "button" && node.textContent === "Activate with passkey");
  const boxes = nodes.filter((node) => node.tagName === "input" && node.type === "checkbox");
  const text = nodes.map((node) => node.textContent).join(" ");
  return { activate, boxes, text, component };
}

test("Add my device with an invitation code stays blocked until the switch is acknowledged (#223)", () => {
  const { activate, boxes, text } = confirmedClaim({ intent: "device", purpose: "adult" });
  assert.match(text, /Joining as a new household member/);
  assert.match(text, /You chose Add my device, but this code is an invitation/);
  assert.equal(boxes.length, 2, "fingerprint comparison and path acknowledgement");
  const [fingerprint, acknowledgement] = boxes;
  assert.equal(acknowledgement.name, "path-acknowledged");
  assert.equal(activate.disabled, true);
  fingerprint.checked = true;
  fingerprint.listeners.change();
  assert.equal(activate.disabled, true, "a compared fingerprint alone does not accept a different path");
  acknowledgement.checked = true;
  acknowledgement.listeners.change();
  assert.equal(activate.disabled, false);
});

test("a joiner whose code matches their choice sees the path and only the fingerprint gate (#223)", () => {
  const { activate, boxes, text } = confirmedClaim({ intent: "device", purpose: "device" });
  assert.match(text, /Adding this device to your membership/);
  assert.doesNotMatch(text, /You chose/);
  assert.equal(boxes.length, 1);
  boxes[0].checked = true;
  boxes[0].listeners.change();
  assert.equal(activate.disabled, false);
});

test("an inviter's code says whether it adds their own device or a new person (#222)", () => {
  for (const [pairing, title, waiting] of [
    [{ purpose: "device" }, "Adding your own device", "Waiting for your other device to enter this code."],
    [{ memberKind: "limited" }, "Inviting another person", "Waiting for the person you invited to enter this code."],
  ]) {
    const component = new KinHousehold();
    component.syncStatus = { enabled: true, memberKind: "adult" };
    component.pairing = { state: "Pending", code: "F7KM-Q2DX", expiresAt: Date.now() + 60_000, ...pairing };
    component.ctx.pairing.pollPairing = () => {};
    component.ctx.pairing.updateCountdown = () => {};
    component.ctx.views.renderMember();
    clearInterval(component.timer);
    const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
    const text = all(component).map((node) => node.textContent).join(" ");
    assert.match(text, new RegExp(title), title);
    assert.ok(text.includes(waiting), waiting);
    if (pairing.memberKind) assert.match(text, /Limited \(child or teen\) access/);
  }
});

// #225: a member sets, edits and removes only their own preferred name, and
// their devices pick it up without losing nicknames.
async function peopleWithNames(names, saved = [], { syncEnabled = true } = {}) {
  const component = new KinHousehold();
  component.identity = { memberId: "me", deviceId: "phone" };
  component.syncStatus = { enabled: syncEnabled, memberKind: "adult" };
  component.localFingerprint = "SELF";
  component.run = async (action) => {
    try { await action(); } catch (error) { component.lastError = error.message; }
  };
  component.ctx.api.openSyncKeyStore = async () => component.syncKeyStore;
  component.api = async (path) => path === "/api/devices"
    ? { canManageMembers: false, devices: [
      { id: "phone", memberId: "me", label: "Chrome on iPhone", revokedAt: null },
      { id: "laptop", memberId: "me", label: "Firefox on Windows", revokedAt: null },
      { id: "partner-mac", memberId: "partner", label: "Safari on Mac", revokedAt: null },
    ] }
    : { devices: [] };
  component.syncKeyStore = { getPinnedDevice: async () => true };
  component.memberNames = {
    load: async () => names.map(([memberId, preferredName]) => ({ memberId, preferredName })),
    rename: async (name) => { saved.push(name); },
  };
  component.deviceNames = { load: async () => [
    { deviceId: "phone", memberId: "me", autoName: "Chrome on iPhone", nickname: "Kitchen phone" },
    { deviceId: "laptop", memberId: "me", autoName: "Firefox on Windows", nickname: null },
    { deviceId: "partner-mac", memberId: "partner", autoName: "Safari on Mac", nickname: null },
  ], rename: async () => {} };
  await component.showDevices();
  const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
  const nodes = all(component);
  const groups = component.children.filter((child) => child.className === "device-group");
  return { component, nodes, groups, saved };
}

test("only your own group offers Set my name, and saving trims it (#225)", async () => {
  const { nodes, groups, saved, component } = await peopleWithNames([["partner", "Sam"]]);
  const nameButtons = nodes.filter((node) => node.tagName === "button" && /my name$/.test(node.textContent));
  assert.deepEqual(nameButtons.map((button) => button.textContent), ["Set my name"]);
  const yours = groups.find((group) => group.dataset.memberId === "me");
  const theirs = groups.find((group) => group.dataset.memberId === "partner");
  const inGroup = (group) => [group, ...group.children.flatMap(function walk(node) { return [node, ...(node.children ?? []).flatMap(walk)]; })];
  assert.ok(inGroup(yours).some((node) => node.className === "member-name"));
  assert.equal(inGroup(theirs).some((node) => node.className === "member-name"), false, "nobody names another member");
  assert.equal(groups.map((group) => group.children[0].textContent).join("|"), "You|Sam");
  const form = nodes.find((node) => node.className === "member-name-form");
  const input = form.children.find((child) => child.tagName === "label").children.find((child) => child.tagName === "input");
  input.value = "  Mikey  ";
  form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, ["Mikey"]);
  input.value = "M".repeat(33);
  form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, ["Mikey"], "a name over 32 characters is not sent");
  assert.match(component.lastError, /32 characters or fewer/);
});

test("a named member can edit or remove their name, and devices follow it (#225)", async () => {
  const { nodes, groups, saved } = await peopleWithNames([["me", "Mikey"], ["partner", "Sam"]]);
  assert.equal(groups[0].children[0].textContent, "Mikey (You)");
  assert.ok(nodes.some((node) => node.tagName === "button" && node.textContent === "Edit my name"));
  const lines = nodes.filter((node) => node.className === "device-name-line")
    .map((line) => line.children.map((part) => part.textContent ?? part).join(""));
  assert.ok(lines.includes("Kitchen phone — Chrome on iPhone · This device · Trusted"), "a nickname is never overwritten");
  assert.ok(lines.includes("Mikey · Firefox on Windows — Trusted"));
  assert.ok(lines.includes("Sam · Safari on Mac — Trusted"));
  const remove = nodes.find((node) => node.tagName === "button" && node.textContent === "Remove my name");
  await remove.listeners.click();
  assert.deepEqual(saved, [""]);
});

test("every member gets the name editor on the household panel, without the Adult-only device list (#225)", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "me", deviceId: "phone" };
  component.syncStatus = { enabled: true, memberKind: "limited" };
  component.run = async (action) => action();
  const saved = [];
  let renders = 0;
  component.render = () => { renders += 1; };
  component.memberNames = { load: async () => [{ memberId: "me", preferredName: "Mikey" }, { memberId: "other", preferredName: "Sam" }], rename: async (name) => { saved.push(name); } };
  let listed = 0;
  component.showDevices = async () => { listed += 1; };
  component.ctx.views.renderMember();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
  const nodes = all(component);
  assert.ok(nodes.some((node) => node.tagName === "button" && node.textContent === "Edit my name"), "the current name is loaded into the editor");
  const form = nodes.find((node) => node.className === "member-name-form");
  const input = form.children.find((child) => child.tagName === "label").children.find((child) => child.tagName === "input");
  assert.equal(input.value, "Mikey");
  input.value = "Mike";
  form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, ["Mike"]);
  assert.equal(renders, 1, "saving refreshes the panel");
  assert.equal(listed, 0, "the trusted-device list (Adults only) is never needed");
});

test("without device sync no name editor is offered, since names can't be read back (#225)", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "me", deviceId: "phone" };
  component.syncStatus = { enabled: false, memberKind: "adult" };
  component.memberNames = { load: async () => [], rename: async () => {} };
  component.ctx.views.renderMember();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
  assert.equal(all(component).some((node) => node.className === "member-name"), false);
  const people = await peopleWithNames([], [], { syncEnabled: false });
  assert.equal(people.nodes.some((node) => node.className === "member-name"), false);
});

test("nobody else can pose as You, and you can't save You as your name (#225)", async () => {
  const { groups, nodes, saved, component } = await peopleWithNames([["partner", "Mikey (You)"]]);
  assert.equal(groups.map((group) => group.children[0].textContent).join("|"), "You|Household member 1");
  const lines = nodes.filter((node) => node.className === "device-name-line")
    .map((line) => line.children.map((part) => part.textContent ?? part).join(""));
  assert.ok(lines.includes("Safari on Mac — Trusted"), "the impostor name never reaches a device label");
  const form = nodes.find((node) => node.className === "member-name-form");
  const input = form.children.find((child) => child.tagName === "label").children.find((child) => child.tagName === "input");
  input.value = " you ";
  form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, []);
  assert.match(component.lastError, /rather than “You”/);
});

// A pairing poll that re-renders while People & devices is still building
// must not leave a half-built page (rows lost, actions appended to the other
// view). Seen intermittently in CI as "No revoke control".
test("People & devices stops writing when another render takes the panel mid-build", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "me", deviceId: "phone" };
  component.localFingerprint = "SELF";
  component.run = async (action) => action();
  component.ctx.api.openSyncKeyStore = async () => component.syncKeyStore;
  component.api = async (path) => path === "/api/devices"
    ? { canManageMembers: true, devices: [
      { id: "phone", memberId: "me", label: "Chrome on iPhone", revokedAt: null },
      { id: "laptop", memberId: "me", label: "Edge on Windows", revokedAt: null },
    ] }
    : { devices: [{ deviceId: "laptop", memberId: "me", fingerprint: "ABCD", publicKeys: {} }] };
  const marker = { tagName: "p", textContent: "Pairing confirmed.", children: [] };
  component.syncKeyStore = {
    getPinnedDevice: async () => {
      // The poll's render lands while the device rows are being built.
      component.viewGeneration += 1;
      component.replaceChildren(marker);
      return true;
    },
  };
  let polled = false;
  component.poll = setTimeout(() => { polled = true; }, 5);
  await component.showDevices();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(component.children, [marker], "the newer render keeps the panel; nothing is appended after it");
  assert.equal(polled, false, "opening People & devices cancels a pending pairing poll");
});

test("a pairing poll answered after People & devices opened leaves that view alone", async () => {
  const component = new KinHousehold();
  component.pairing = { pairingId: "p1", state: "Claimed", version: 1 };
  component.viewGeneration = 7;
  let renders = 0, errors = 0;
  component.render = () => { renders += 1; };
  component.renderError = () => { errors += 1; };
  let answer;
  component.api = () => new Promise((resolve) => { answer = resolve; });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => realSetTimeout(callback, 0);
  try {
    component.ctx.pairing.pollPairing();
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    // People & devices takes the panel while the request is in flight.
    component.viewGeneration += 1;
    answer({ state: "Confirmed", version: 2 });
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(component.pairing.state, "Confirmed", "the new pairing state is still recorded");
  assert.equal(renders, 0, "but the newer view is not replaced");
  assert.equal(errors, 0);
});

test("a household refresh that finishes after People & devices opened leaves that view alone", async () => {
  const component = new KinHousehold();
  component.viewGeneration = 3;
  let renders = 0, notified = 0;
  component.render = () => { renders += 1; };
  component.addEventListener("kin:household-status", () => { notified += 1; });
  component.ctx.api.notifyStatus = () => { notified += 1; };
  let release;
  component.api = async (path) => {
    if (path === "/api/status") {
      await new Promise((resolve) => { release = resolve; });
      return { identity: null, householdLifecycle: null, claim: null };
    }
    return {};
  };
  const loading = component.ctx.api.load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  component.viewGeneration += 1; // People & devices opens meanwhile.
  release();
  const result = await loading;
  assert.equal(result.loaded, true);
  assert.equal(renders, 0, "the newer view is not replaced");
  assert.equal(notified, 1, "the app still hears the new status");
});

test("Household access gives way to a view that took the panel while it loaded (#327)", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "current-member" };
  component.run = async (action) => action();
  const marker = { tagName: "p", children: [], textContent: "People & devices" };
  let answer;
  component.api = () => new Promise((resolve) => { answer = resolve; });
  const loading = component.showHousehold();
  const generation = component.viewGeneration;
  assert.ok(generation >= 1, "it takes the panel like other views");
  // People & devices (or Back) takes over before the answer arrives.
  component.viewGeneration += 1;
  component.replaceChildren(marker);
  answer({ members: [{ id: "current-member", current: true, active: true, kind: "adult" }] });
  await loading;
  assert.deepEqual(component.children, [marker], "the late answer doesn't replace the newer view");
});

test("the claim poll leaves a newer view alone and doesn't repaint an unchanged claim (#327)", async () => {
  const component = new KinHousehold();
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => { timers.push(callback); return timers.length; };
  try {
    let renders = 0;
    component.render = () => { renders += 1; };
    component.renderError = () => { renders += 100; };
    component.claim = { state: "Claimed", code: "x" };
    component.api = async () => ({ state: "Claimed", code: "x" });
    component.viewGeneration = 4;
    component.ctx.pairing.schedulePoll();
    await timers.shift()();
    assert.equal(renders, 0, "an unchanged claim is not repainted (focus and typing survive)");
    component.ctx.pairing.schedulePoll();
    component.viewGeneration = 5;
    component.api = async () => ({ state: "Approved" });
    await timers.at(-1)();
    assert.equal(renders, 0, "a newer view keeps the panel");
    assert.deepEqual(component.claim, { state: "Claimed", code: "x" });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// Moving the household to a home server (ADR 0026, #737).
const everything = (items) => items.flatMap((item) => [item, ...everything(item.children ?? [])]);
const texts = (component) => everything(component.children).map((child) => child.textContent).filter(Boolean);

test("a moved household says where it went; only an admin may undo it or close it here", () => {
  const moved = (admin, undoUntil, remindAt) => {
    const component = new KinHousehold();
    component.householdLifecycle = { state: "moved", movedTo: "https://fern.home.kin.journeytocode.io", movedAt: "2026-10-25T12:00:00.000Z", undoUntil, remindAt, admin, message: "This household moved." };
    component.render();
    return component;
  };
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  const member = moved(false, later, later);
  assert.ok(texts(member).includes("Your household moved"));
  const link = everything(member.children).find((child) => child.tagName === "a");
  assert.equal(link.href, "https://fern.home.kin.journeytocode.io");
  assert.ok(texts(member).some((text) => /username and password, or your backup code/.test(text)));
  assert.ok(texts(member).some((text) => /passkey for this address doesn't work at the new one/.test(text)));
  assert.equal(everything(member.children).some((child) => child.tagName === "button"), false, "a member gets no admin controls");
  const admin = moved(true, later, later);
  const buttons = everything(admin.children).filter((child) => child.tagName === "button").map((button) => button.textContent);
  assert.ok(buttons.some((label) => label.startsWith("Undo the move (until")));
  assert.ok(buttons.includes("Close the household here"));
  assert.equal(texts(admin).some((text) => /It's been a week/.test(text)), false);
  const weekOn = moved(true, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString());
  const afterDay = everything(weekOn.children).filter((child) => child.tagName === "button").map((button) => button.textContent);
  assert.deepEqual(afterDay, ["Close the household here"], "undo is gone after a day");
  assert.ok(texts(weekOn).some((text) => /It's been a week since the move/.test(text)));
});

test("while the household is moving, the panel says so and looks again", () => {
  const component = new KinHousehold();
  component.householdLifecycle = { state: "moving", movedTo: "https://fern.home.kin.journeytocode.io" };
  component.render();
  try {
    assert.ok(texts(component).includes("Your household is moving"));
    assert.ok(component.poll, "it asks again");
  } finally {
    clearTimeout(component.poll);
  }
});

test("the admin's move screen: who can sign in there, then the address, the code and a fresh passkey", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "founder" };
  component.run = async (action) => action();
  component.memberNames = { load: async () => [{ memberId: "founder", preferredName: "Sam" }, { memberId: "partner", preferredName: "Alex" }] };
  const calls = [];
  component.api = async (path, options = {}) => {
    calls.push([path, options.body ? JSON.parse(options.body) : null]);
    if (path === "/api/household/move") return {
      readiness: { canStart: true, members: [
        { memberId: "founder", kind: "adult", admin: true, account: true, ready: "password" },
        { memberId: "partner", kind: "adult", admin: false, account: true, ready: null },
        { memberId: "child", kind: "limited", admin: false, account: false, ready: null },
      ] },
      move: { state: "none", lastError: { code: "move-code-wrong", attemptsLeft: 3 } },
    };
    if (path === "/api/household/move/options") return { flow: "flow", targetOrigin: "https://fern.home.kin.journeytocode.io", publicKey: { challenge: "YQ", allowCredentials: [{ id: "Yg" }] } };
    if (path === "/api/household/move/finish") return { state: "sending" };
    throw new Error(`unexpected ${path}`);
  };
  await component.ctx.move.show();
  const lines = texts(component);
  assert.ok(lines.includes("Move to a home server"));
  assert.ok(lines.some((text) => /That move code isn't right.*3 more tries/.test(text)), "the last attempt's reason");
  const readiness = everything(component.children).filter((child) => child.dataset?.memberId);
  assert.deepEqual(readiness.map((item) => [item.dataset.memberId, item.dataset.ready]), [["founder", "yes"], ["partner", "no"], ["child", "no"]]);
  assert.match(readiness[0].textContent, /^Sam \(you\) can sign in with their password/);
  assert.match(readiness[1].textContent, /^Alex has only a passkey\. Ask them to save a backup code first/);
  assert.match(readiness[2].textContent, /no account yet, so they re-join with an invitation/);
  assert.ok(everything(component.children).some((child) => child.tagName === "form"), "the address and code");
  globalThis.confirm = () => true;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { credentials: { get: async () => ({ id: "credential-founder", type: "public-key", response: { clientDataJSON: new Uint8Array([1]), getTransports: () => [] } }) } },
  });
  await component.ctx.move.start("fern.home.kin.journeytocode.io", "ABCDE-23456");
  try {
    assert.deepEqual(calls.slice(1).map(([path]) => path), ["/api/household/move/options", "/api/household/move/finish"]);
    assert.deepEqual(calls[1][1], { address: "fern.home.kin.journeytocode.io" });
    assert.equal(calls[2][1].code, "ABCDE-23456");
    assert.equal(calls[2][1].flow, "flow");
    assert.equal(calls[2][1].credential.id, "credential-founder");
    assert.ok(texts(component).includes("Moving the household"), "it follows the move");
  } finally {
    clearTimeout(component.poll);
  }
});

test("without a ready admin there is nothing to start, and refusals are said in plain words", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "founder" };
  component.run = async (action) => action();
  component.api = async (path) => {
    if (path === "/api/household/move") return { readiness: { canStart: false, members: [{ memberId: "founder", kind: "adult", admin: true, account: true, ready: null }] }, move: { state: "none", lastError: null } };
    throw Object.assign(new Error("refused"), { code: "move-address-refused" });
  };
  await component.ctx.move.show();
  assert.equal(everything(component.children).some((child) => child.tagName === "form"), false);
  assert.ok(texts(component).some((text) => /At least one household admin needs a password or a backup code/.test(text)));
  globalThis.confirm = () => true;
  await component.ctx.move.start("printer.local", "ABCDE-23456");
  const message = component.children.find((child) => child.className === "household-message");
  assert.match(message.textContent, /private or local network/);
});
