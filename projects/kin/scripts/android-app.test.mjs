// The Google Play wrapper (ADR 0020, #535, #536): its configuration agrees
// with Kin's own files, its package name and origin live in one place, its
// pictures are what the renderer draws, and no signing key is in the project.
// CI also checks the built APK itself (scripts/check-android-app.mjs).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseAssetLinks } from "../server/asset-links.mjs";
import { checkJsonResource, checkManifest, checkShortcuts, elements, expectedApp, LAUNCHER, loadExpected, parseProperties, SHORTCUT_LIMIT } from "./check-android-app.mjs";
import { androidIconSpecs, decodePng, DENSITIES, rasterize } from "./render-icons.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const android = join(root, "android");
const res = join(android, "app", "src", "main", "res");
// As LF: a Windows checkout may give any text file CRLF endings.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const webManifest = JSON.parse(read("web", "manifest.webmanifest"));
const expected = loadExpected(root);

/** Every file under android/ except build output, relative to android/. */
function androidFiles(directory = android) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["build", ".gradle", ".idea"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...androidFiles(path));
    else found.push(relative(android, path).replaceAll("\\", "/"));
  }
  return found;
}

/** The source manifest as the Android build merges it: placeholders filled
 * and the attributes Gradle adds from app/build.gradle. */
function mergedManifest() {
  const build = read("android", "app", "build.gradle");
  assert.match(build, /^\s*targetSdk 36$/m, "targets API 36 (Play requirement)");
  assert.match(build, /^\s*compileSdk 36$/m);
  return read("android", "app", "src", "main", "AndroidManifest.xml")
    .replaceAll("${kinHost}", expected.host)
    .replaceAll("${applicationId}", expected.packageName)
    .replace("<manifest ", `<manifest package="${expected.packageName}" android:versionCode="${expected.versionCode}" android:versionName="${expected.versionName}" `)
    .replace("<application", '<uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36" />\n<application');
}

test("the package name and origin are set once, in android/gradle.properties", () => {
  assert.equal(expected.packageName, "kin.app");
  assert.equal(expected.host, "kin.journeytocode.io");
  assert.ok(parseAssetLinks({ packageName: expected.packageName, fingerprints: Array(32).fill("AB").join(":") }), "the service accepts it as KIN_ANDROID_PACKAGE");
  assert.match(expected.versionCode, /^[1-9]\d*$/);
  assert.equal(expected.versionName, JSON.parse(read("package.json")).version, "versionName is Kin's version");
  const text = androidFiles().filter((file) => !file.endsWith(".png"));
  assert.ok(text.includes("app/src/main/AndroidManifest.xml"));
  for (const value of [expected.packageName, expected.host]) {
    const holders = text.filter((file) => read("android", file).includes(value));
    assert.deepEqual(holders, ["gradle.properties"], `"${value}" is written only in gradle.properties`);
  }
});

test("the manifest opens the origin, shares, delegates notifications and falls back to a Custom Tab", () => {
  assert.deepEqual(checkManifest(mergedManifest(), expected), []);
  // Calendar files (.ics) go to the calendar (#660).
  assert.deepEqual(expected.shareMimeTypes, ["text/plain", "image/*", "application/pdf", "text/calendar"]);
  assert.equal(expected.shareTarget.action, "https://kin.journeytocode.io/share");
  assert.equal(webManifest.share_target.method, "POST");
  assert.equal(webManifest.share_target.enctype, "multipart/form-data");
});

test("the manifest check notices a wrong origin, package, fallback or share filter", () => {
  const manifest = mergedManifest();
  const problems = (xml) => checkManifest(xml, expected).join("\n");
  assert.match(problems(manifest.replaceAll(expected.host, "example.org")), /DEFAULT_URL[\s\S]*verified link filter/);
  assert.match(problems(manifest.replace(`package="${expected.packageName}"`, 'package="org.other"')), /package is "org.other"/);
  assert.match(problems(manifest.replace('android:value="customtabs"', 'android:value="webview"')), /fallback/);
  assert.match(problems(manifest.replace('<data android:mimeType="application/pdf" />', "")), /share filter accepts/);
  assert.match(problems(manifest.replace("android.permission.POST_NOTIFICATIONS", "android.permission.INTERNET")), /POST_NOTIFICATIONS/);
  assert.match(problems(manifest.replace(/android:autoVerify="true"/, "")), /verified link filter/);
});

test("expectations follow gradle.properties and the web manifest", () => {
  const properties = parseProperties("# comment\nkinPackage = org.example.kin\nkinHost=kin.example.org\nkinVersionCode=7\n");
  const app = expectedApp({ properties, webManifest, version: "9.9.9" });
  assert.equal(app.defaultUrl, "https://kin.example.org/");
  assert.equal(app.versionCode, "7");
  assert.deepEqual(app.assetStatements, [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "web", site: "https://kin.example.org" } }]);
  assert.equal(app.shortcuts.length, Math.min(SHORTCUT_LIMIT, webManifest.shortcuts.length));
  assert.equal(app.shortcuts[0].url, new URL(webManifest.shortcuts[0].url, "https://kin.example.org/").href);
  assert.ok(app.shortcuts.every((shortcut) => shortcut.url.startsWith("https://kin.example.org/#")), "shortcuts open in-app routes on the origin");
});

test("JSON resources and shortcuts are compared with what the web manifest says", () => {
  assert.deepEqual(checkJsonResource("shareTarget", ` ${JSON.stringify(expected.shareTarget)}\n`, expected.shareTarget), []);
  assert.match(checkJsonResource("shareTarget", "{action:", expected.shareTarget)[0], /isn't JSON/);
  assert.match(checkJsonResource("assetStatements", "[]", expected.assetStatements)[0], /expected/);
  const xml = (shortcuts) => `<shortcuts>${shortcuts.map((shortcut) => `<shortcut><intent android:action="android.intent.action.MAIN" android:targetPackage="${expected.packageName}" android:targetClass="${LAUNCHER}" android:data="${shortcut.url}" /></shortcut>`).join("")}</shortcuts>`;
  assert.deepEqual(checkShortcuts(xml(expected.shortcuts), expected), []);
  assert.match(checkShortcuts(xml(expected.shortcuts.slice(1)), expected).join("\n"), /shortcuts, expected/);
  assert.match(checkShortcuts(xml([...expected.shortcuts].reverse()), expected).join("\n"), /opens/);
  assert.deepEqual(elements('<a b="1 &amp; 2"/>'), [{ name: "a", attributes: { b: "1 & 2" } }]);
});

test("every shortcut, launcher, splash and notification picture is there at every density, as rendered", () => {
  const specs = androidIconSpecs();
  for (const shortcut of expected.shortcuts)
    for (const density of Object.keys(DENSITIES))
      assert.ok(specs.some((spec) => spec.file === `drawable-${density}/${shortcut.drawable}.png`), `${shortcut.drawable} at ${density}`);
  for (const name of ["mipmap-%/ic_launcher", "mipmap-%/ic_launcher_foreground", "drawable-%/splash", "drawable-%/ic_notification_icon"])
    for (const density of Object.keys(DENSITIES)) assert.ok(specs.some((spec) => spec.file === `${name.replace("%", density)}.png`), name);
  for (const { file, size, layers } of specs) {
    const committed = decodePng(readFileSync(join(res, file)));
    assert.equal(committed.width, size, file);
    assert.ok(Buffer.from(committed.rgba).equals(Buffer.from(rasterize(size, layers))), `${file} differs: run node scripts/render-icons.mjs`);
  }
  // The adaptive icon's background is the app icon's tile colour.
  const tile = /<rect[^>]*fill="(#[0-9a-f]{6})"/i.exec(read("web", "icon.svg"))[1];
  assert.match(read("android", "app", "src", "main", "res", "values", "colors.xml"), new RegExp(`name="ic_launcher_background">${tile}<`, "i"));
});

test("no signing key, password or fingerprint is in the Android project", () => {
  const files = androidFiles();
  assert.deepEqual(files.filter((file) => /\.(jks|keystore|p12|pfx|pem)$|(^|\/)keystore\.properties$|(^|\/)local\.properties$/.test(file)), []);
  const fingerprint = /\b([0-9A-F]{2}:){31}[0-9A-F]{2}\b/i;
  for (const file of files.filter((name) => !name.endsWith(".png"))) {
    const text = read("android", file);
    // A password written as a literal, in Gradle or a properties file.
    assert.doesNotMatch(text, /PRIVATE KEY|(store|key)Password\s*[=:]\s*["'][^"']+["']/, file);
    if (file.endsWith(".properties")) assert.doesNotMatch(text, /^\s*(store|key)Password\s*[=:]/m, file);
    assert.doesNotMatch(text, fingerprint, file);
  }
  assert.doesNotMatch(read("docs", "ANDROID.md"), fingerprint, "docs show the fingerprint format, never a real one");
  const ignored = read(".gitignore").split(/\r?\n/);
  for (const rule of ["*.jks", "*.keystore", "keystore.properties"]) assert.ok(ignored.includes(rule), `.gitignore has ${rule}`);
});

test("CI builds a debug app, checks it and keeps it, without any signing secret", () => {
  const workflow = read("docs", "ci", "kin-verification.workflow.yml");
  const job = /^ {2}android:\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/m.exec(workflow)?.[1];
  assert.ok(job, "the workflow has an android job");
  assert.match(job, /actions\/setup-java@/);
  assert.match(job, /gradle\/actions\/setup-gradle@/);
  assert.match(job, /assembleDebug/);
  assert.match(job, /bundleDebug/);
  assert.match(job, /node scripts\/check-android-app\.mjs/);
  assert.match(job, /actions\/upload-artifact@/);
  assert.doesNotMatch(job, /secrets\.|KIN_ANDROID_KEY|(bundle|assemble)Release/, "release builds and signing stay manual");
});
