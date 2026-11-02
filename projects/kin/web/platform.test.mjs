// #163 onboarding: automatic device names and iPhone/iPad install help.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticDeviceName, describePlatform, installHelp } from "./platform.js";

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1",
  iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
  iphoneEdge: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15",
  ipadDesktopMode: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  androidSamsung: "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  iphoneInstagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76 Instagram 380.0.0.30.84 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556)",
  iphoneGoogleApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/385.0.795283505 Mobile/15E148 Safari/604.1",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};
const name = (userAgent, extra = {}) => automaticDeviceName(describePlatform({ userAgent, ...extra }));

test("automatic device names say which browser on which device", () => {
  assert.equal(name(UA.iphoneSafari), "Safari on iPhone");
  assert.equal(name(UA.iphoneChrome), "Chrome on iPhone");
  assert.equal(name(UA.iphoneFirefox), "Firefox on iPhone");
  assert.equal(name(UA.iphoneEdge), "Edge on iPhone");
  assert.equal(name(UA.ipadDesktopMode, { maxTouchPoints: 5 }), "Safari on iPad");
  assert.equal(name(UA.macSafari), "Safari on Mac");
  assert.equal(name(UA.androidChrome), "Chrome on Android");
  assert.equal(name(UA.androidSamsung), "Samsung Internet on Android");
  assert.equal(name(UA.windowsEdge), "Edge on Windows");
  assert.equal(name(UA.windowsChrome), "Chrome on Windows");
  assert.equal(name(UA.linuxFirefox), "Firefox on Linux");
  assert.equal(name(UA.chromebook), "Chrome on ChromeOS");
  assert.equal(name(UA.iphoneInstagram), "iPhone");
  assert.equal(name(UA.iphoneGoogleApp), "iPhone");
});

test("the installed iPhone app is named for the device, and unknown agents fall back", () => {
  assert.equal(name(UA.iphoneChrome, { standalone: true }), "iPhone");
  assert.equal(name(""), "This device");
  for (const userAgent of Object.values(UA)) assert.ok(name(userAgent).length <= 48);
});

test("iPhone and iPad browsers get Home Screen steps; others and the installed app don't", () => {
  const safari = installHelp(describePlatform({ userAgent: UA.iphoneSafari }));
  assert.match(safari.steps.join(" "), /Tap Share.*iOS 26.*Add to Home Screen.*Open as Web App, keep it on/);
  assert.match(safari.note, /own data, separate from this browser/);
  assert.equal(safari.steps.at(-1), "Open Kin from your Home Screen and set it up there.");
  const chrome = installHelp(describePlatform({ userAgent: UA.iphoneChrome }));
  assert.match(chrome.steps.join(" "), /address bar.*iOS 16\.4.*Add to Home Screen/);
  assert.match(installHelp(describePlatform({ userAgent: UA.iphoneFirefox })).steps.join(" "), /Firefox's Share menu.*Safari/);
  for (const userAgent of [UA.iphoneInstagram, UA.iphoneGoogleApp]) {
    const inApp = installHelp(describePlatform({ userAgent }));
    assert.match(inApp.steps[0], /^Open this page in Safari/);
    assert.ok(!inApp.steps.join(" ").includes("Add to Home Screen"), "an app's built-in browser can't add to the Home Screen");
  }
  assert.equal(installHelp(describePlatform({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 5 })).title, "Install Kin on your iPad");
  assert.equal(installHelp(describePlatform({ userAgent: UA.iphoneSafari, standalone: true })), null);
  assert.equal(installHelp(describePlatform({ userAgent: UA.androidChrome })), null);
  assert.equal(installHelp(describePlatform({ userAgent: UA.macSafari })), null);
});
