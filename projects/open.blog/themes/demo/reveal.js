// <demo-reveal>: a minimal heading effect to copy from.
//
// open.blog wraps every page and section title in this element because
// theme.json says `"options": { "headingWrapper": "demo-reveal" }`, and loads
// this file because of `"scripts": ["reveal.js"]`. The element splits its
// text into words and lets each one rise into place when the heading scrolls
// into view. Everything the effect needs is in these ~40 lines.
//
// The rules any heading effect should follow (see docs/theme-components.md):
// 1. The full text is already in the DOM; never fetch or rebuild it.
// 2. Keep an accessible copy for screen readers; animate a hidden copy.
// 3. Do nothing when the reader prefers reduced motion.
// 4. Never change the heading's size while animating (no layout shift).
// 5. Guard the define() call so the file can be loaded twice safely.

class DemoReveal extends HTMLElement {
  connectedCallback() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (this.dataset.done) return;
    const text = this.textContent;
    if (!text.trim()) return;

    // Accessible copy, visually hidden. The animated words are decoration.
    const accessible = document.createElement("span");
    accessible.textContent = text;
    accessible.style.cssText =
      "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";
    const words = document.createElement("span");
    words.setAttribute("aria-hidden", "true");
    text.split(/(\s+)/).forEach((part, i) => {
      if (!part) return;
      if (/^\s+$/.test(part)) return words.append(part);
      const word = document.createElement("span");
      word.className = "demo-word";
      word.style.transitionDelay = `${Math.min(i * 40, 600)}ms`;
      word.textContent = part;
      words.append(word);
    });
    this.replaceChildren(accessible, words);

    this.observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        this.observer.disconnect();
        this.setAttribute("revealed", "");
        this.dataset.done = "true";
      }
    });
    this.observer.observe(this);
  }

  disconnectedCallback() {
    this.observer?.disconnect();
  }
}

if (!customElements.get("demo-reveal")) {
  customElements.define("demo-reveal", DemoReveal);
}
