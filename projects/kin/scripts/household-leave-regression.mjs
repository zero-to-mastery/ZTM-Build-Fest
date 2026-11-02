export async function householdLeaveChecks() {
  const app = document.querySelector("kin-app");
  const originalFetch = globalThis.fetch;
  const originalGet = navigator.credentials.get;
  const originalConfirm = globalThis.confirm;
  const identity = { householdId: "fixture-household", memberId: "fixture-member", deviceId: "fixture-device" };
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  let controller;
  let assertionRequests = 0;
  let finishRequests = 0;
  let confirmation = true;
  let failure;
  const requests = [];
  const mount = () => {
    controller = document.createElement("kin-household");
    controller.load = async () => {};
    app.append(controller);
    controller.identity = { ...identity };
  };
  const assertion = { id: "AQ", type: "public-key", response: {
    clientDataJSON: new Uint8Array([1]).buffer,
    authenticatorData: new Uint8Array([1]).buffer,
    signature: new Uint8Array([1]).buffer, userHandle: null,
  } };
  globalThis.confirm = () => { requests.push("confirm"); return confirmation; };
  globalThis.fetch = async (path, options) => {
    if (path === "/api/household/membership/remove/options") {
      requests.push("options");
      check(JSON.parse(options.body).memberId === identity.memberId, "challenge targets the departing adult");
      return new Response(JSON.stringify({ flow: "leave-fixture", publicKey: {
        challenge: "AQ", rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: "AQ" }], userVerification: "required",
      } }));
    }
    if (path === "/api/household/membership/remove/finish") {
      finishRequests++;
      requests.push("finish");
      check(JSON.parse(options.body).flow === "leave-fixture", "finish carries the action-bound challenge");
      check(JSON.parse(options.body).credential.id === "AQ", "finish carries the fresh assertion");
      return failure ? new Response(JSON.stringify({ error: "passkey_verification_failed", message: "Passkey verification failed. No authorization change was made." }), { status: 401 }) : new Response(JSON.stringify({ removed: true, memberId: identity.memberId }));
    }
    if (path === "/api/household/membership") throw new Error("Session-only leave must never be called.");
    return originalFetch(path, options);
  };
  navigator.credentials.get = async options => {
    assertionRequests++;
    requests.push("passkey");
    check(options.publicKey.challenge instanceof Uint8Array, "passkey receives a decoded challenge");
    check(options.publicKey.userVerification === "required", "passkey requires user verification");
    check(options.signal === controller.connectionAbort.signal, "passkey is tied to this unlocked lifetime");
    const status = controller.querySelector(".household-message");
    check(status?.getAttribute("role") === "status" && status.textContent.includes("passkey"), "passkey prompt is an accessible status");
    if (failure instanceof Error) throw failure;
    return assertion;
  };
  try {
    mount();
    confirmation = false;
    await controller.leave();
    check(assertionRequests === 0 && finishRequests === 0, "cancelled destructive confirmation never authenticates or mutates");
    confirmation = true;
    for (const name of ["NotAllowedError", "AbortError"]) {
      failure = new DOMException("Cancelled", name);
      requests.length = 0;
      await controller.leave();
      check(requests.join(",") === "confirm,options,passkey", "confirmation precedes fresh passkey and cancellation never finishes");
      check(finishRequests === 0 && controller.identity.memberId === identity.memberId, "cancelled passkey preserves household authority");
      const alert = controller.querySelector(".household-message");
      check(alert.getAttribute("role") === "alert" && alert.textContent.includes("cancelled"), "cancellation has calm accessible feedback");
      check(controller.getAttribute("aria-busy") === "false", "cancellation clears busy state");
    }
    failure = true;
    await controller.leave();
    check(finishRequests === 1 && controller.identity.memberId === identity.memberId && app.vault, "server rejection preserves local authority");
    check(controller.querySelector(".household-message").getAttribute("role") === "alert", "server failure has accessible feedback");
    failure = false;
    requests.length = 0;
    controller.message("Confirm with your passkey to leave the household.");
    await controller.authenticateRemoval(identity.memberId);
    check(requests.join(",") === "options,passkey,finish", "shared removal helper sends a fresh assertion before mutation");
  } finally {
    controller?.remove();
    globalThis.fetch = originalFetch;
    navigator.credentials.get = originalGet;
    globalThis.confirm = originalConfirm;
  }
  return { checks };
}
