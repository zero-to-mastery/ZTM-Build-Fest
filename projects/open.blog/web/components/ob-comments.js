// Progressive comments for a hosted open.blog engagement endpoint. Untrusted
// comment content is assigned only through textContent. With the `reports`
// attribute (abuse reports open on the post, ADR 0107), each comment offers a
// private, anonymous report form. With the public `captcha-*` attributes
// (ADR 0322) the first comment of a session is verified by a hosted challenge
// that only loads once the reader starts writing.

import { reportForm } from "./ob-abuse-report.js";
import { MESSAGES, commentCaptcha } from "./comment-captcha.js";

export class ObComments extends HTMLElement {
  async connectedCallback() {
    const path = this.getAttribute("path");
    const endpoint = (this.getAttribute("endpoint") || "").replace(/\/$/, "");
    const locked = this.getAttribute("mode") === "locked";
    const reports = this.getAttribute("reports") !== null;
    if (!path || !endpoint) return;
    this.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Comments";
    const status = document.createElement("p");
    status.className = "ob-comments-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const list = document.createElement("ol");
    list.className = "ob-comments-list";
    const form = document.createElement("form");
    form.className = "ob-comments-form";
    form.append(this.field("Name", "text", 80), this.field("Comment", "textarea", 4000));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Submit for review";
    // A test seam: injected clock, storage and provider loader. Never set by the site.
    const captcha = !locked && this.getAttribute("captcha-provider") === "turnstile"
      ? commentCaptcha(this, { form, submit, status }, this.captchaOptions) : null;
    this.captcha = captcha;
    if (captcha) form.append(...captcha.nodes);
    form.append(submit);
    this.append(heading, status, list);
    if (locked) {
      const notice = document.createElement("p");
      notice.className = "ob-comments-locked";
      notice.textContent = "This discussion is read-only.";
      this.append(notice);
    } else {
      this.append(form);
    }

    const render = (comments) => {
      list.replaceChildren();
      for (const comment of comments) {
        const item = document.createElement("li");
        const meta = document.createElement("p");
        const name = document.createElement("strong");
        name.textContent = comment.authorName;
        const time = document.createElement("time");
        time.dateTime = comment.createdAt;
        time.textContent = new Date(comment.createdAt).toLocaleDateString();
        meta.append(name, " · ", time);
        const body = document.createElement("p");
        body.textContent = comment.body;
        item.append(meta, body);
        if (reports && typeof comment.id === "string") item.append(reportForm({ endpoint, source: "comment", id: comment.id, subject: "this comment" }));
        list.append(item);
      }
      if (!comments.length) status.textContent = "No approved comments yet.";
    };

    const load = async () => {
      const response = await fetch(`${endpoint}/comments?path=${encodeURIComponent(path)}`, { credentials: "omit" });
      if (!response.ok) throw new Error("Comments are unavailable.");
      render((await response.json()).comments || []);
    };
    try {
      await load();
    } catch (error) {
      status.textContent = error.message;
    }
    if (locked) return;
    let busy = false;
    let retryWhenVerified = false;
    // `retried` is true for the one automatic resend after a fresh challenge.
    const send = async (retried) => {
      if (busy) return;
      busy = true;
      const controls = form.querySelectorAll("input,textarea,button");
      controls.forEach((control) => { control.disabled = true; });
      status.textContent = "Submitting…";
      let verification = {};
      try {
        if (captcha) {
          verification = captcha.proof();
          if (!verification) {
            verification = {};
            captcha.needed();
            return;
          }
        }
        const response = await fetch(`${endpoint}/comments`, {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, authorName: form.elements.authorName.value, body: form.elements.body.value, ...verification }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (captcha && (result.code === "captcha_required" || result.code === "captcha_expired")) {
            captcha.rejected();
            if (!retried) {
              retryWhenVerified = true;
              status.textContent = MESSAGES.retrying;
              return;
            }
          } else if (captcha && verification.captchaToken) captcha.spent();
          throw new Error(result.error || "The comment could not be submitted.");
        }
        captcha?.accepted(result);
        form.reset();
        status.textContent = result.status === "approved" ? "Comment published." : "Comment submitted for moderation.";
      } catch (error) {
        status.textContent = error.message;
      } finally {
        busy = false;
        controls.forEach((control) => { control.disabled = false; });
      }
    };
    captcha?.onToken(() => {
      if (!retryWhenVerified) return;
      retryWhenVerified = false;
      void send(true);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      retryWhenVerified = false;
      await send(false);
    });
  }

  disconnectedCallback() { this.captcha?.destroy(); }

  field(labelText, kind, maximum) {
    const label = document.createElement("label");
    const labelCopy = document.createElement("span");
    labelCopy.textContent = labelText;
    const control = document.createElement(kind === "textarea" ? "textarea" : "input");
    control.name = kind === "textarea" ? "body" : "authorName";
    control.required = true;
    control.maxLength = maximum;
    if (kind === "textarea") control.rows = 5;
    else control.autocomplete = "name";
    label.append(labelCopy, control);
    return label;
  }
}

if (!customElements.get("ob-comments")) customElements.define("ob-comments", ObComments);
