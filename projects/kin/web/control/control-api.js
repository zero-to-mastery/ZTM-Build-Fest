// The control panel's requests (ADR 0025 §11, #718). The same page works
// two ways, chosen by where it was opened:
//
// - on the home server's own computer (http://localhost:<port>/control/):
//   the loopback API, /control/api/*, with a one-time code and a control
//   session; a change is confirmed with a code Kin prints;
// - through the household's address (https://<name>/control/): the app's
//   API, /api/control/*, as a signed-in household admin; a change is
//   confirmed with the admin's passkey or password.
//
// Errors carry the server's code (`error.code`), which explain.js puts in
// plain words.

export class ControlApiError extends Error {
  constructor(code, message, status, extra = {}) {
    super(message);
    this.name = "ControlApiError";
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export class ControlApi {
  constructor({ loopback = globalThis.location?.protocol === "http:", fetchImpl = (...args) => globalThis.fetch(...args), confirm } = {}) {
    this.loopback = loopback;
    this.fetch = fetchImpl;
    // How a remote change is confirmed: household/fresh-confirmation.js,
    // loaded only when needed (it brings the password derivation with it).
    this.confirm = confirm ?? (async (started) => (await import("../components/household/fresh-confirmation.js")).freshConfirmation(started));
  }

  async #request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await this.fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ControlApiError("network", "Kin didn't answer.", 0);
    }
    let value = null;
    try { value = await response.json(); } catch { value = null; }
    if (!response.ok) {
      const { error, message, ...extra } = value ?? {};
      throw new ControlApiError(typeof error === "string" ? error : "control-failed", typeof message === "string" ? message : "Kin couldn't do that.", response.status, extra);
    }
    return value;
  }

  /**
   * What the page shows now. Loopback: the panel's state (signed in or not,
   * setup, status). Remote: { remote: true, signedIn, admin, status }.
   */
  async state() {
    if (this.loopback) return { remote: false, ...(await this.#request("/control/api/state")) };
    try {
      return { remote: true, signedIn: true, admin: true, status: await this.#request("/api/control/status") };
    } catch (error) {
      if (error.code === "authentication_required" || error.code === "device_not_trusted" || error.status === 401) return { remote: true, signedIn: false, admin: false };
      if (error.code === "household_admin_required") return { remote: true, signedIn: true, admin: false };
      throw error;
    }
  }

  /** A loopback panel request (sign-in, the setup steps, codes). */
  post(route, body = {}) {
    if (!this.loopback) return Promise.reject(new ControlApiError("control-loopback-only", "This works only on the home server's own computer.", 403));
    return this.#request(`/control/api/${route}`, { method: "POST", body });
  }

  /**
   * Makes a change after a fresh confirmation. Loopback: `code` is the
   * confirmation code Kin printed. Remote: Kin asks for the admin's
   * passkey (or password) through `confirm`.
   */
  async change(change, { code } = {}) {
    if (this.loopback) return this.post("change", { change, code });
    const started = await this.#request("/api/control/change/options", { method: "POST", body: { change } });
    const proof = await this.confirm(started);
    return this.#request("/api/control/change/finish", { method: "POST", body: { flow: started.flow, ...proof } });
  }
}
