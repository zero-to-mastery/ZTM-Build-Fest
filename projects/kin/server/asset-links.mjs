// Digital Asset Links for the Google Play app (#532, epic #527): the file
// that proves an Android app and this website belong together, so the app
// (a Trusted Web Activity) opens Kin full-screen with no address bar.
//
// Configured per deployment, never in code: KIN_ANDROID_PACKAGE (the app's
// package name) and KIN_ANDROID_CERT_SHA256 (one or more SHA-256 signing
// certificate fingerprints, comma-separated, "AA:BB:…" with 32 bytes). With
// neither set the route answers 404, as a deployment without an Android app
// should. A half or malformed configuration stops startup with an
// explanation rather than publishing a file Android would reject.

const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export class AssetLinksError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssetLinksError";
  }
}

/**
 * The asset-links statement list for a package and its fingerprints, or null
 * when neither is configured. Throws AssetLinksError for a partial or invalid
 * configuration.
 */
export function parseAssetLinks({ packageName = "", fingerprints = "" } = {}) {
  const name = String(packageName ?? "").trim();
  const prints = String(fingerprints ?? "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  if (!name && !prints.length) return null;
  if (!name) throw new AssetLinksError("KIN_ANDROID_CERT_SHA256 is set but KIN_ANDROID_PACKAGE isn't. Set both, or neither.");
  if (!prints.length) throw new AssetLinksError("KIN_ANDROID_PACKAGE is set but KIN_ANDROID_CERT_SHA256 isn't. Set both, or neither.");
  if (!PACKAGE.test(name) || name.length > 255)
    throw new AssetLinksError(`KIN_ANDROID_PACKAGE "${name}" isn't an Android package name (like org.example.kin).`);
  for (const print of prints)
    if (!FINGERPRINT.test(print))
      throw new AssetLinksError(`"${print}" in KIN_ANDROID_CERT_SHA256 isn't a SHA-256 fingerprint (32 bytes as AA:BB:…).`);
  if (prints.length > 8) throw new AssetLinksError("KIN_ANDROID_CERT_SHA256 lists more than 8 fingerprints.");
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: name, sha256_cert_fingerprints: [...new Set(prints)] },
  }];
}

/** Serves GET/HEAD /.well-known/assetlinks.json: the statements, or 404. */
export function serveAssetLinks(request, response, statements) {
  if (!statements) {
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ error: "not_found" }));
    return;
  }
  const body = JSON.stringify(statements);
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "public, max-age=3600",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}
