// The kitchen display's "is this the adult?" dialog (#670, #705): leaving
// display mode, and changing a child's reward there, ask the device's adult
// for their passkey or password (display/leave.js askAdult decides which
// are offered, says what to show, and checks them). A wrong secret keeps the
// dialog open with a calm message; Cancel, Escape and a closed dialog
// resolve false. Nothing typed is kept once it closes. Its class names stay
// display-leave-* for both uses (display.css sizes them as 64px targets).
import { ADULT_CHECKS, methodsText } from "../../display/leave.js";

const LABELS = { passkey: "Use my passkey", password: "Use my password", "backup-key": "Use the backup key" };

/**
 * Shows the dialog in `host` and resolves true once `check(method, secret)`
 * resolves, false when it is cancelled. `check` rejects with an Error whose
 * `code` is "unlock_failed" (or "password_rejected") for a wrong secret.
 * The words come from ADULT_CHECKS[purpose] unless given: `title`, `lead`,
 * `none`, `stay` and `canceled`. `onSettle(value)`, when given, is called
 * synchronously as the dialog closes, before the promise resolves: the
 * caller releases its guard there, so a press straight after a cancel is
 * a new press, not one caught in the promise chain's microtasks (#705).
 */
export function askAdultDialog({ methods, check, host = document.body, purpose = "leave", onSettle = null, ...words }) {
  const text = { ...(ADULT_CHECKS[purpose] ?? ADULT_CHECKS.leave), ...words };
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "display-leave-dialog";
    dialog.dataset.purpose = purpose;
    dialog.setAttribute("aria-labelledby", "display-leave-title");
    dialog.setAttribute("aria-describedby", "display-leave-lead");
    const title = document.createElement("h2");
    title.id = "display-leave-title";
    title.textContent = text.title;
    const lead = document.createElement("p");
    lead.id = "display-leave-lead";
    lead.textContent = methods.length ? `${text.lead} Confirm with ${methodsText(methods)}.` : text.none;
    const message = document.createElement("p");
    message.className = "error-message display-leave-message";
    message.setAttribute("role", "alert");
    const choices = document.createElement("div");
    choices.className = "dialog-actions display-leave-choices";
    const form = document.createElement("form");
    form.className = "display-leave-form";
    form.hidden = true;
    const label = document.createElement("label");
    label.htmlFor = "display-leave-secret";
    const input = document.createElement("input");
    input.id = label.htmlFor;
    input.type = "password";
    input.required = true;
    input.spellcheck = false;
    input.autocomplete = "current-password";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-action";
    submit.textContent = "Confirm";
    form.append(label, input, submit);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "display-leave-cancel";
    cancel.textContent = text.stay;
    let method = null;
    let busy = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.value = "";
      if (dialog.open) dialog.close();
      dialog.remove();
      try { onSettle?.(value); } finally { resolve(value); }
    };
    const setBusy = (value) => {
      busy = value;
      for (const control of dialog.querySelectorAll("button, input")) if (control !== cancel) control.disabled = value;
    };
    const attempt = async (secret) => {
      if (busy) return;
      setBusy(true);
      message.textContent = method === "passkey" ? "Waiting for your passkey…" : "Checking…";
      try {
        await check(method, secret);
        finish(true);
      } catch (error) {
        if (settled) return;
        message.textContent = error?.name === "NotAllowedError" || error?.name === "AbortError"
          ? text.canceled
          : method === "password" ? "That password didn't work. Check it and try again."
            : method === "backup-key" ? "That backup key didn't work. Check it and try again."
              : (error?.message || "Kin couldn't confirm that. Try again.");
        if (method !== "passkey") input.value = "";
      } finally {
        if (!settled) {
          setBusy(false);
          // Focused once enabled again: a disabled box can't take it.
          if (method !== "passkey") input.focus();
        }
      }
    };
    for (const entry of methods) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = entry === methods[0] ? "primary-action" : "secondary";
      button.dataset.method = entry;
      button.textContent = LABELS[entry] ?? entry;
      button.addEventListener("click", () => {
        method = entry;
        message.textContent = "";
        if (entry === "passkey") { form.hidden = true; void attempt(null); return; }
        label.textContent = entry === "password" ? "Your password" : "Backup key";
        input.autocomplete = entry === "password" ? "current-password" : "off";
        form.hidden = false;
        input.value = "";
        input.focus();
      });
      choices.append(button);
    }
    choices.append(cancel);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (input.value) void attempt(input.value);
    });
    cancel.addEventListener("click", () => finish(false));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
    dialog.append(title, lead, choices, form, message);
    host.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    (choices.querySelector("button") ?? cancel).focus();
  });
}
