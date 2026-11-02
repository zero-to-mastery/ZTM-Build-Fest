// The only device label the server keeps is the automatic one a device
// reports for itself: "Chrome on iPhone", "iPhone", "Firefox", or "Device"
// (#71). Anything a person typed is a nickname, and nicknames live only in
// encrypted household events the server cannot read. A label built from any
// other text becomes "Device", so a typed name never reaches the server's
// storage, logs or backups.
//
// These lists mirror DEVICE_OS_NAMES and DEVICE_BROWSER_NAMES in
// web/platform.js (device-label.test.mjs checks they stay equal).
export const DEVICE_OS_NAMES = Object.freeze(["iPhone", "iPad", "Android", "Windows", "ChromeOS", "Mac", "Linux"]);
export const DEVICE_BROWSER_NAMES = Object.freeze(["Chrome", "Firefox", "Edge", "Opera", "Samsung Internet", "Safari"]);
export const UNKNOWN_DEVICE_LABEL = "Device";

const AUTOMATIC_LABELS = new Set([
  UNKNOWN_DEVICE_LABEL,
  ...DEVICE_OS_NAMES,
  ...DEVICE_BROWSER_NAMES,
  ...DEVICE_BROWSER_NAMES.flatMap((browser) => DEVICE_OS_NAMES.map((os) => `${browser} on ${os}`)),
]);

/** The label to store for `value`: itself when it is an automatic name,
 * otherwise "Device". Never throws; any input is accepted. */
export function deviceLabel(value) {
  const label = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return AUTOMATIC_LABELS.has(label) ? label : UNKNOWN_DEVICE_LABEL;
}
