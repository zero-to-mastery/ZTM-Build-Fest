// <ob-theme-toggle> flips between light and dark and remembers the choice.
//
// The server renders the element with `hidden` (it does nothing without JS);
// this component reveals it. It sets `data-theme` on <html>, which the theme's
// generated tokens.css uses to switch colour scheme. A tiny inline script in
// every page <head> restores the saved value before first paint.

const KEY = "ob-scheme";

function systemScheme() {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function currentScheme() {
  const set = document.documentElement.dataset.theme;
  return set === "light" || set === "dark" ? set : systemScheme();
}

class ObThemeToggle extends HTMLElement {
  connectedCallback() {
    this.hidden = false;
    this.button = this.querySelector("button");
    if (!this.button) return;
    this.button.addEventListener("click", this.#toggle);
    this.#sync();
  }

  disconnectedCallback() {
    this.button?.removeEventListener("click", this.#toggle);
  }

  #toggle = () => {
    const next = currentScheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage can be blocked (private windows); the choice just won't persist.
    }
    this.#sync();
    this.dispatchEvent(new CustomEvent("ob-scheme-change", { detail: next, bubbles: true }));
  };

  #sync() {
    const scheme = currentScheme();
    this.button.setAttribute("aria-pressed", String(scheme === "dark"));
    this.button.title = `Switch to ${scheme === "dark" ? "light" : "dark"} mode`;
  }
}

if (!customElements.get("ob-theme-toggle")) {
  customElements.define("ob-theme-toggle", ObThemeToggle);
}
