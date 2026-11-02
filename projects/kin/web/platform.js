// What device and browser Kin is running in, for two onboarding needs:
//   - an automatic device name ("Chrome on iPhone"), so nobody has to type one
//     when creating or joining a household. It is the only device name the
//     server learns; nicknames are encrypted household events (#71);
//   - how to install Kin to the Home Screen on iPhone and iPad, where no
//     browser offers an install prompt.
// Pure functions over plain values, so they're unit-tested without a browser;
// currentPlatform() reads the live browser.

const IOS_BROWSERS = [
  [/CriOS\//, "Chrome"],
  [/FxiOS\//, "Firefox"],
  [/EdgiOS\//, "Edge"],
  [/OPiOS\/|OPT\//, "Opera"],
];
const BROWSERS = [
  [/Edg(?:e|A)?\//, "Edge"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrom(?:e|ium)\//, "Chrome"],
  [/Safari\//, "Safari"],
];

/** Every name describePlatform can report. The server accepts only device
 * labels built from these (server/pairing-service/device-label.mjs). */
export const DEVICE_OS_NAMES = Object.freeze(["iPhone", "iPad", "Android", "Windows", "ChromeOS", "Mac", "Linux"]);
export const DEVICE_BROWSER_NAMES = Object.freeze([...new Set([...IOS_BROWSERS, ...BROWSERS].map(([, name]) => name))]);

export function describePlatform({ userAgent = "", maxTouchPoints = 0, standalone = false } = {}) {
  let os = null;
  if (/iPhone|iPod/.test(userAgent)) os = "iPhone";
  else if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) os = "iPad";
  else if (/Android/.test(userAgent)) os = "Android";
  else if (/Windows/.test(userAgent)) os = "Windows";
  else if (/CrOS/.test(userAgent)) os = "ChromeOS";
  else if (/Macintosh/.test(userAgent)) os = "Mac";
  else if (/Linux/.test(userAgent)) os = "Linux";
  const ios = os === "iPhone" || os === "iPad";
  // Every iOS browser is WebKit; only its own token says which app it is.
  // Safari itself carries "Version/… Safari/"; an app's built-in browser
  // (Instagram, Facebook, the Google app, Gmail…) has neither, and can't add
  // to the Home Screen, so it stays unknown (null).
  const table = ios ? IOS_BROWSERS : BROWSERS;
  const browser = table.find(([pattern]) => pattern.test(userAgent))?.[1] ??
    (ios && /Version\/[\d.]+.*Safari\//.test(userAgent) ? "Safari" : null);
  return { os, browser, ios, standalone: Boolean(standalone) };
}

// "Chrome on iPhone"; just "iPhone" inside the installed Home Screen app,
// where the browser it was added from no longer matters.
export function automaticDeviceName({ os, browser, ios, standalone }) {
  if (ios && standalone) return os;
  if (os && browser) return `${browser} on ${os}`;
  return os ?? browser ?? "This device";
}

// The automatic name other people see: "This device" only makes sense on the
// device itself, so an unrecognized device is just "Device".
export function householdDeviceName(platform) {
  const name = automaticDeviceName(platform);
  return name === "This device" ? "Device" : name;
}

// Home Screen install steps for iPhone and iPad browsers, or null when Kin is
// already installed or the browser has its own install prompt.
export function installHelp({ os, browser, ios, standalone }) {
  if (!ios || standalone) return null;
  const device = os ?? "iPhone";
  // iOS 26 adds an "Open as Web App" switch to Add to Home Screen. Left off,
  // the icon opens in the browser and shares its data, so it must stay on.
  const add = "Choose Add to Home Screen (it may be under View More). If you see Open as Web App, keep it on. Then tap Add.";
  const steps =
    browser === "Safari"
      ? ["Tap Share. (On iOS 26, tap ••• next to the address bar first.)", add]
      : browser === "Chrome"
        ? ["Tap Share in the address bar. (Needs iOS 16.4 or later.)", add]
        : browser
          ? [`Open ${browser}'s Share menu.`, `${add} If it isn't there, open this page in Safari and add it from there.`]
          : ["Open this page in Safari: use this app's menu, such as Open in Safari or Open in browser.", "Then follow the steps Kin shows there."];
  return {
    title: `Install Kin on your ${device}`,
    steps: browser ? [...steps, "Open Kin from your Home Screen and set it up there."] : steps,
    note: `On ${device}, the Home Screen app keeps its own data, separate from this browser. Set up in the app you'll use every day.`,
  };
}

export function currentPlatform() {
  return describePlatform({
    userAgent: globalThis.navigator?.userAgent ?? "",
    maxTouchPoints: globalThis.navigator?.maxTouchPoints ?? 0,
    standalone:
      globalThis.navigator?.standalone === true ||
      Boolean(globalThis.matchMedia?.("(display-mode: standalone)").matches),
  });
}
