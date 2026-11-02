// <ob-share url="..." title="..."> wraps the server-rendered share links and
// adds what only JavaScript can offer: the device's own share sheet (Web Share
// API) and a "Copy link" button. Without JavaScript the plain links remain.

class ObShare extends HTMLElement {
  connectedCallback() {
    const list = this.querySelector("ul");
    if (!list) return;
    const url = this.getAttribute("url") || location.href;
    const title = this.getAttribute("title") || document.title;

    if (navigator.share) {
      list.prepend(this.#item("Share…", async () => {
        try {
          await navigator.share({ title, url });
        } catch {
          // The reader dismissed the sheet; nothing to do.
        }
      }));
    }
    if (navigator.clipboard) {
      const item = this.#item("Copy link", async (button) => {
        try {
          await navigator.clipboard.writeText(url);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Copy failed";
        }
        setTimeout(() => (button.textContent = "Copy link"), 1600);
      });
      list.append(item);
    }
  }

  #item(label, onClick) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => onClick(button));
    li.append(button);
    return li;
  }
}

if (!customElements.get("ob-share")) {
  customElements.define("ob-share", ObShare);
}
