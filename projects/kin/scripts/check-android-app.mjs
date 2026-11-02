// Checks a built Kin Android app (#535, #536, ADR 0020) against what Kin's own
// files say it must be, independently of the Gradle script that built it:
// the package and origin from android/gradle.properties, the version from
// package.json, and the names, share target and shortcuts from
// web/manifest.webmanifest.
//
//   node scripts/check-android-app.mjs [path/to/app.apk]
//
// It reads the APK with the Android SDK's apkanalyzer (APKANALYZER, or
// $ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer). CI runs it after the
// debug build; the pure functions below are unit-tested in
// android-app.test.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LAUNCHER = "com.google.androidbrowserhelper.trusted.LauncherActivity";
export const SHORTCUT_LIMIT = 4;

/** `key=value` lines of a .properties file (no continuations, which ours
 * don't use). */
export function parseProperties(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#!\s][^=:\s]*)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

/** What the app must contain, from Kin's files. */
export function expectedApp({ properties, webManifest, version }) {
  const packageName = properties.get("kinPackage");
  const host = properties.get("kinHost");
  const origin = `https://${host}`;
  const share = webManifest.share_target;
  return {
    packageName,
    host,
    versionName: version,
    versionCode: properties.get("kinVersionCode"),
    defaultUrl: `${origin}/`,
    assetStatements: [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "web", site: origin } }],
    shareTarget: { action: new URL(share.action, origin).href, method: share.method, enctype: share.enctype, params: share.params },
    shareMimeTypes: ["text/plain", ...share.params.files.flatMap((file) => file.accept)],
    shortcuts: webManifest.shortcuts.slice(0, SHORTCUT_LIMIT).map((shortcut) => ({
      name: shortcut.name,
      url: new URL(shortcut.url, `${origin}/`).href,
      drawable: `shortcut_${/^\/icons\/shortcut-([a-z0-9-]+)-\d+\.png$/.exec(shortcut.icons?.[0]?.src ?? "")?.[1]?.replaceAll("-", "_")}`,
    })),
  };
}

/** Kin's files, read from the project. */
export function loadExpected(root = ROOT) {
  return expectedApp({
    properties: parseProperties(readFileSync(join(root, "android", "gradle.properties"), "utf8")),
    webManifest: JSON.parse(readFileSync(join(root, "web", "manifest.webmanifest"), "utf8")),
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  });
}

// ---- A small reader for the decoded XML apkanalyzer prints ---------------

/** Every element's name and attributes, in document order. */
export function elements(xml) {
  const found = [];
  for (const match of xml.matchAll(/<([A-Za-z][\w.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*\/?>/g)) {
    const attributes = {};
    for (const attribute of match[2].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attributes[attribute[1]] = attribute[2].replaceAll("&amp;", "&").replaceAll("&quot;", '"');
    found.push({ name: match[1], attributes });
  }
  return found;
}

/** The text of each `<name …>…</name>` block. */
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, "g"))].map((match) => match[0]);
const metaData = (xml, name) => elements(xml).find((element) => element.name === "meta-data" && element.attributes["android:name"] === name)?.attributes;

/** Problems with the app's merged AndroidManifest.xml. */
export function checkManifest(xml, expected) {
  const problems = [];
  const all = elements(xml);
  const manifest = all.find((element) => element.name === "manifest")?.attributes ?? {};
  const expect = (condition, message) => { if (!condition) problems.push(message); };
  expect(manifest.package === expected.packageName, `package is "${manifest.package}", expected "${expected.packageName}" (android/gradle.properties kinPackage)`);
  expect(manifest["android:versionName"] === expected.versionName, `versionName is "${manifest["android:versionName"]}", expected Kin's version "${expected.versionName}"`);
  expect(manifest["android:versionCode"] === expected.versionCode, `versionCode is "${manifest["android:versionCode"]}", expected "${expected.versionCode}"`);
  const sdk = all.find((element) => element.name === "uses-sdk")?.attributes ?? {};
  expect(sdk["android:targetSdkVersion"] === "36", `targetSdkVersion is "${sdk["android:targetSdkVersion"]}", expected 36 (Play requirement)`);
  const permissions = all.filter((element) => element.name === "uses-permission").map((element) => element.attributes["android:name"]);
  expect(permissions.includes("android.permission.POST_NOTIFICATIONS"), "no POST_NOTIFICATIONS permission (Android 13+ notifications)");
  // The app itself never goes online: the browser does (ADR 0020).
  expect(!permissions.includes("android.permission.INTERNET"), "the app asks for INTERNET, which a TWA doesn't need");
  expect(metaData(xml, "android.support.customtabs.trusted.DEFAULT_URL")?.["android:value"] === expected.defaultUrl, `DEFAULT_URL isn't ${expected.defaultUrl}`);
  expect(metaData(xml, "android.support.customtabs.trusted.FALLBACK_STRATEGY")?.["android:value"] === "customtabs", "the fallback isn't a Custom Tab");
  expect(metaData(xml, "android.support.customtabs.trusted.FILE_PROVIDER_AUTHORITY")?.["android:value"] === `${expected.packageName}.fileprovider`, "the splash file provider authority isn't <package>.fileprovider");
  expect(Boolean(metaData(xml, "asset_statements")), "no asset_statements meta-data");
  expect(Boolean(metaData(xml, "android.app.shortcuts")), "no shortcuts meta-data");
  expect(Boolean(metaData(xml, "android.support.customtabs.trusted.METADATA_SHARE_TARGET")), "no share target meta-data");
  expect(all.some((element) => element.name === "provider" && element.attributes["android:authorities"] === `${expected.packageName}.fileprovider`), "no FileProvider for <package>.fileprovider");

  const services = blocks(xml, "service").filter((block) => block.includes("android.support.customtabs.trusted.TRUSTED_WEB_ACTIVITY_SERVICE"));
  expect(services.length === 1, "no notification DelegationService");
  expect(services.some((block) => block.includes("android.support.customtabs.trusted.SMALL_ICON")), "the DelegationService has no SMALL_ICON");

  const filters = blocks(xml, "intent-filter");
  const verified = filters.filter((block) => /android:autoVerify="true"/.test(block) && block.includes("android.intent.action.VIEW"));
  const hosts = verified.flatMap((block) => elements(block).filter((element) => element.name === "data" && element.attributes["android:host"]).map((element) => element.attributes["android:host"]));
  expect(hosts.length === 1 && hosts[0] === expected.host, `the verified link filter covers ${JSON.stringify(hosts)}, expected only "${expected.host}"`);
  const share = filters.find((block) => block.includes("android.intent.action.SEND\""));
  if (!share) problems.push("no share (SEND) intent filter");
  else {
    expect(share.includes("android.intent.action.SEND_MULTIPLE"), "the share filter doesn't take several files (SEND_MULTIPLE)");
    const types = elements(share).filter((element) => element.name === "data").map((element) => element.attributes["android:mimeType"]).sort();
    expect(JSON.stringify(types) === JSON.stringify([...expected.shareMimeTypes].sort()), `the share filter accepts ${JSON.stringify(types)}, expected ${JSON.stringify(expected.shareMimeTypes)}`);
  }
  return problems;
}

/** Problems with a string resource that must hold the given JSON. */
export function checkJsonResource(name, text, value) {
  let parsed;
  try { parsed = JSON.parse(text.trim()); } catch (error) { return [`${name} isn't JSON (${error.message}): ${text.trim().slice(0, 200)}`]; }
  return isDeepStrictEqual(parsed, value) ? [] : [`${name} is ${JSON.stringify(parsed)}, expected ${JSON.stringify(value)}`];
}

/** Problems with res/xml/shortcuts.xml. */
export function checkShortcuts(xml, expected) {
  const problems = [];
  const intents = elements(xml).filter((element) => element.name === "intent").map((element) => element.attributes);
  if (intents.length !== expected.shortcuts.length) problems.push(`${intents.length} shortcuts, expected ${expected.shortcuts.length}`);
  expected.shortcuts.forEach((shortcut, index) => {
    const intent = intents[index] ?? {};
    if (intent["android:data"] !== shortcut.url) problems.push(`shortcut ${index + 1} ("${shortcut.name}") opens ${intent["android:data"]}, expected ${shortcut.url}`);
    if (intent["android:targetPackage"] !== expected.packageName) problems.push(`shortcut ${index + 1} targets package ${intent["android:targetPackage"]}`);
    if (intent["android:targetClass"] !== LAUNCHER) problems.push(`shortcut ${index + 1} targets ${intent["android:targetClass"]}, expected ${LAUNCHER}`);
  });
  return problems;
}

// ---- Running apkanalyzer ----------------------------------------------------

function apkanalyzer() {
  if (process.env.APKANALYZER) return process.env.APKANALYZER;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const candidate = sdk && join(sdk, "cmdline-tools", "latest", "bin", process.platform === "win32" ? "apkanalyzer.bat" : "apkanalyzer");
  if (candidate && existsSync(candidate)) return candidate;
  throw new Error("apkanalyzer not found: set APKANALYZER or ANDROID_HOME (Android SDK command-line tools).");
}

function analyze(tool, args) {
  const result = spawnSync(tool, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`apkanalyzer ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout || String(result.error)).trim().slice(0, 500)}`);
  return result.stdout;
}

function main(argv) {
  const apk = argv[0] ?? join(ROOT, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const expected = loadExpected();
  const tool = apkanalyzer();
  const resource = (name) => analyze(tool, ["resources", "value", "--config", "default", "--name", name, "--type", "string", apk]);
  const problems = [
    ...checkManifest(analyze(tool, ["manifest", "print", apk]), expected),
    ...checkJsonResource("shareTarget", resource("shareTarget"), expected.shareTarget),
    ...checkJsonResource("assetStatements", resource("assetStatements"), expected.assetStatements),
    ...checkShortcuts(analyze(tool, ["resources", "xml", "--file", "res/xml/shortcuts.xml", apk]), expected),
  ];
  if (problems.length) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    process.exitCode = 1;
  } else console.log(`PASS ${apk}: ${expected.packageName} for https://${expected.host}/, ${expected.shortcuts.length} shortcuts, share target and asset statements as the web manifest says.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
}
