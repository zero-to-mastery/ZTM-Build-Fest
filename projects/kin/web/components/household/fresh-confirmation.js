// Confirming a sensitive action (approving a device, admin changes,
// removing someone, deleting the household). A member with a passkey uses
// it, exactly as before. A member who signed up with a password and has no
// passkey yet (#558) re-enters their password: the service's options then
// carry `password: { username, salt, iterations }`, and the finish request
// carries authKey (derived here; the password never leaves this device).
import { authenticationOptions, credentialJson } from "./auth.js";
import { confirmationAuthKey } from "../../security/account-setup.js";

/**
 * The fields a `/finish` request needs: `{ credential }` from the passkey, or
 * `{ authKey }` from a fresh password. `started` is the options response.
 * Cancelling either rejects with a NotAllowedError, which the callers
 * already explain as "cancelled".
 */
export async function freshConfirmation(started, { signal, askPassword = askForPassword } = {}) {
  if (started?.password) {
    const password = await askPassword(started.password, { signal });
    return { authKey: await confirmationAuthKey(password, started.password) };
  }
  const credential = await navigator.credentials.get({ publicKey: authenticationOptions(started.publicKey), signal });
  return { credential: credentialJson(credential) };
}

/** Wording for "confirm with …" lines: the passkey, or the password. */
export function confirmWith(started) {
  return started?.password ? "your password" : "your passkey";
}

/**
 * Asks for the member's password in a modal dialog and resolves to it.
 * The username rides in a field only a password manager reads, so it offers
 * the right saved entry. Cancel, Escape or an aborted `signal` reject with
 * NotAllowedError; nothing is kept once the dialog closes.
 */
export function askForPassword({ username } = {}, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.className = "password-confirmation";
    dialog.setAttribute("aria-labelledby", "password-confirmation-title");
    const form = document.createElement("form");
    const title = document.createElement("h2");
    title.id = "password-confirmation-title";
    title.textContent = "Confirm it's you";
    const lead = document.createElement("p");
    lead.textContent = "Enter your Kin password to continue.";
    const account = document.createElement("input");
    account.type = "text";
    account.autocomplete = "username";
    account.value = username ?? "";
    account.tabIndex = -1;
    account.className = "visually-hidden";
    account.setAttribute("aria-hidden", "true");
    const label = document.createElement("label");
    label.htmlFor = "password-confirmation-input";
    label.textContent = "Password";
    const input = document.createElement("input");
    input.id = label.htmlFor;
    input.type = "password";
    input.autocomplete = "current-password";
    input.required = true;
    input.spellcheck = false;
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.className = "primary-action";
    confirm.textContent = "Confirm";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    actions.append(confirm, cancel);
    form.append(title, lead, account, label, input, actions);
    dialog.append(form);
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      input.value = "";
      if (dialog.open) dialog.close();
      dialog.remove();
      if (error) reject(error); else resolve(value);
    };
    const cancelled = () => new DOMException("The password confirmation was cancelled.", "NotAllowedError");
    const onAbort = () => finish(null, cancelled());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (input.value) finish(input.value);
    });
    cancel.addEventListener("click", () => finish(null, cancelled()));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null, cancelled()); });
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    input.focus();
  });
}
