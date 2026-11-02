// The daily Certificate Transparency check (#727, ADR 0025 §5 "The residual
// risk", THREAT-MODEL).
//
// Every publicly trusted certificate is logged. Once a day the home server
// asks a CT search service (crt.sh by default; any service with the same
// query shape works) for unexpired certificates covering its name, and checks
// each against what it obtained itself:
//
//   1. the serial number is one of ours (certificate-history.json), or
//   2. the certificate's public key is one of ours (SHA-256 of the SPKI);
//      precertificates share the final certificate's key, so they match too.
//
// Anything else is a certificate this server's ACME account didn't get (CT
// can't name the account, but only this server holds the keys it put in its
// CSRs), and the control panel turns red. The search service learns the
// home's name, which is public anyway (it is in CT and DNS); nothing else is
// sent.
//
// Queries (crt.sh):
//   GET <base>?q=<name>&output=json&exclude=expired      -> [{ id, serial_number, name_value, issuer_name, not_before, not_after }]
//   GET <base>?q=*.<parent>&output=json&exclude=expired  -> wildcards that would cover the name
//   GET <base>?d=<id>                                    -> the certificate, PEM
import { X509Certificate, createHash } from "node:crypto";

export const DEFAULT_CT_SEARCH = "https://crt.sh/";

export class TransparencyError extends Error {
  constructor(code, message) { super(message); this.name = "TransparencyError"; this.code = code; }
}

/** A serial number as lowercase hex without leading zeros. */
export const normalizeSerial = (serial) => String(serial ?? "").toLowerCase().replace(/[^0-9a-f]/g, "").replace(/^0+(?=.)/, "");

const spkiHash = (certificate) => createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("hex");

/** True if `pattern` (a name from a certificate, maybe `*.x`) covers `name`. */
export function nameCovers(pattern, name) {
  const value = String(pattern).trim().toLowerCase();
  if (value === name) return true;
  return value.startsWith("*.") && name.endsWith(value.slice(1)) && !name.slice(0, -(value.length - 1)).includes(".");
}

/**
 * @param {object} options
 * @param {string} options.name the home server's name
 * @param {Function} options.transport see transport.mjs
 * @param {{ serials: Iterable<string>, spkiHashes: Iterable<string> }} options.known
 * @param {string} [options.baseUrl]
 * @param {number} [options.maxDownloads] certificates fetched individually per check
 * @returns {Promise<{ checked: number, unexpected: Array<{ id: string, serial: string, issuer: string, notBefore: string, notAfter: string }> }>}
 */
export async function checkTransparency({ name, transport, known, baseUrl = DEFAULT_CT_SEARCH, maxDownloads = 50 }) {
  const host = String(name).toLowerCase();
  const serials = new Set([...known.serials].map(normalizeSerial));
  const keys = new Set([...known.spkiHashes].map((hash) => String(hash).toLowerCase()));
  const parent = host.slice(host.indexOf(".") + 1);
  const queries = [host, ...(parent.includes(".") ? [`*.${parent}`] : [])];

  const entries = new Map();
  for (const query of queries) {
    const url = new URL(baseUrl);
    url.search = new URLSearchParams({ q: query, output: "json", exclude: "expired" }).toString();
    const list = await fetchJson(transport, url.href);
    for (const entry of list) {
      if (!entry || entry.id === undefined) continue;
      const names = String(entry.name_value ?? entry.common_name ?? "").split(/\s+/).filter(Boolean);
      if (names.some((pattern) => nameCovers(pattern, host))) entries.set(String(entry.id), entry);
    }
  }

  const unexpected = [];
  let downloads = 0;
  for (const [id, entry] of entries) {
    if (serials.has(normalizeSerial(entry.serial_number))) continue;
    if (++downloads > maxDownloads) throw new TransparencyError("ct-too-many", "too many unknown certificates to check");
    const url = new URL(baseUrl);
    url.search = new URLSearchParams({ d: id }).toString();
    const response = await request(transport, url.href);
    let certificate;
    try { certificate = new X509Certificate(await response.text()); } catch { throw new TransparencyError("ct-bad-response", "the CT search returned an unreadable certificate"); }
    if (keys.has(spkiHash(certificate))) continue;
    unexpected.push({
      id,
      serial: normalizeSerial(certificate.serialNumber),
      issuer: String(entry.issuer_name ?? certificate.issuer).slice(0, 200),
      notBefore: new Date(certificate.validFrom).toISOString(),
      notAfter: new Date(certificate.validTo).toISOString(),
    });
  }
  return { checked: entries.size, unexpected };
}

async function request(transport, url) {
  let response;
  try { response = await transport(url, { method: "GET", headers: { accept: "application/json" } }); } catch {
    throw new TransparencyError("ct-unavailable", "the CT search service could not be reached");
  }
  if (response.status !== 200) throw new TransparencyError("ct-unavailable", `the CT search service answered ${response.status}`);
  return response;
}

async function fetchJson(transport, url) {
  const response = await request(transport, url);
  let value;
  try { value = JSON.parse(await response.text()); } catch { throw new TransparencyError("ct-bad-response", "the CT search returned unreadable JSON"); }
  if (!Array.isArray(value)) throw new TransparencyError("ct-bad-response", "the CT search returned no list");
  return value;
}
