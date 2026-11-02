// <ob-back-to-top> shows a round button after the reader scrolls down a screen.

class ObBackToTop extends HTMLElement {
  connectedCallback() {
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.setAttribute("aria-label", "Back to top");
    this.button.innerHTML = '<span aria-hidden="true">↑</span>';
    this.button.addEventListener("click", () => {
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      document.getElementById("main")?.focus({ preventScroll: true });
    });
    this.replaceChildren(this.button);
    addEventListener("scroll", this.#update, { passive: true });
    this.#update();
  }

  disconnectedCallback() {
    removeEventListener("scroll", this.#update);
  }

  #update = () => {
    this.toggleAttribute("visible", window.scrollY > window.innerHeight);
    this.button.tabIndex = this.hasAttribute("visible") ? 0 : -1;
  };
}

if (!customElements.get("ob-back-to-top")) {
  customElements.define("ob-back-to-top", ObBackToTop);
}
