export function installOfflineStatus() {
  const banner = document.createElement("div");
  banner.className = "offline-status";
  banner.setAttribute("role", "status");
  document.querySelector("app-shell").prepend(banner);
  const update = () => {
    banner.textContent = navigator.onLine
      ? ""
      : "Offline — local editing, analysis and export remain available. GitHub and remote media need a connection.";
    banner.hidden = navigator.onLine;
  };
  addEventListener("online", update);
  addEventListener("offline", update);
  update();
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register(new URL("sw.js", document.baseURI), { updateViaCache: "none" })
    .then((registration) => {
      const offer = () => {
        if (
          !registration.active ||
          !registration.waiting ||
          document.querySelector(".update-status")
        )
          return;
        const notice = document.createElement("div");
        notice.className = "update-status";
        notice.innerHTML =
          "<p>A new README Studio version is ready.</p><button>Save and reload update</button>";
        banner.after(notice);
        notice.querySelector("button").onclick = () => {
          if (!document.querySelector("app-shell").save()) {
            notice.querySelector("p").textContent =
              "Save failed. Download your work before reloading.";
            return;
          }
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => location.reload(),
            { once: true },
          );
          registration.waiting?.postMessage("ACTIVATE_UPDATE");
        };
      };
      offer();
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", () => {
          if (registration.waiting) offer();
        });
      });
      addEventListener("online", () => registration.update().catch(() => {}));
    })
    .catch(() => {
      /* Local editing remains available even when offline installation is blocked. */
    });
}
