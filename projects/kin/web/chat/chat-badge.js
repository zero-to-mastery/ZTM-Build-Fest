// The installed app's home-screen badge (#133), through the Badging API
// where the browser has one. The number is the unread chat count, worked
// out on this device from decrypted state; nothing about it is sent anywhere.
// Browsers without the API (or a page that isn't an installed app) simply
// show no badge.

/** Shows `count` on the app icon, or clears the badge when it is zero. */
export function setAppBadge(count, nav = globalThis.navigator) {
  try {
    const number = Number.isSafeInteger(count) && count > 0 ? count : 0;
    const result = number ? nav?.setAppBadge?.(number) : nav?.clearAppBadge?.();
    // Both return promises that reject when the app isn't installed or the
    // permission is off: that only means no badge.
    if (result && typeof result.catch === "function") result.catch(() => {});
    return typeof (number ? nav?.setAppBadge : nav?.clearAppBadge) === "function";
  } catch {
    return false;
  }
}
