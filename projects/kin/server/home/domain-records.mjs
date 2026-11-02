// The DNS records a household's own domain needs (ADR 0025 §3, §4, §5;
// #719), and a check that they are in place before setup continues:
//
//   <domain>             A / AAAA  the connection relay's addresses (not a CNAME:
//                                  CAA lookups follow a CNAME, which would hand
//                                  CAA back to the relay's zone)
//   _kin-relay.<domain>  TXT       base64url SHA-256 of the home public key
//   <domain>             CAA       0 issue "letsencrypt.org; accounturi=<this home
//                                  server's ACME account>; validationmethods=tls-alpn-01"
//                                  0 issuewild ";"
//   <domain>             HTTPS     none with an `ech` parameter
//
// The relay checks the TXT record itself before it routes the domain; the
// setup page also asks it (CONTROL CHECK) so a record the relay can't see
// yet is reported here, not as a silent wait.
//
// Results carry the record, what was expected, what was found and a
// problem code the panel explains in plain words (web/control/explain.js).
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { keyHashText } from "../../relay/ktun.mjs";
import { caaRecords } from "../acme/renewal.mjs";
import { publishesEch } from "./dns-https.mjs";

export const DOMAIN_PROBLEMS = Object.freeze([
  "dns-unavailable", "dns-relay-unknown", "dns-cname", "dns-address-missing", "dns-address-wrong",
  "dns-txt-missing", "dns-caa-missing", "dns-caa-other", "dns-ech", "relay-txt-not-seen",
]);

const NOT_FOUND = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

async function lookup(resolve) {
  try { return { values: await resolve() }; } catch (error) {
    if (NOT_FOUND.has(error?.code)) return { values: [] };
    return { values: [], error: error?.code ?? "error" };
  }
}

/** The records to create, as the panel shows them. `relayAddresses` are the
 * relay's published IPv4 and IPv6 addresses. */
export function expectedRecords({ domain, relayAddresses, publicKey, accountUrl }) {
  const records = [];
  for (const address of relayAddresses) records.push({ type: isIP(address) === 6 ? "AAAA" : "A", name: domain, value: address });
  records.push({ type: "TXT", name: `_kin-relay.${domain}`, value: keyHashText(publicKey) });
  if (accountUrl) {
    for (const line of caaRecords(domain, accountUrl)) {
      const value = line.slice(line.indexOf(" CAA ") + 5);
      records.push({ type: "CAA", name: domain, value });
    }
  }
  return records;
}

/** The parts of a CAA `issue` value: the issuer and its parameters. */
function parseIssue(value) {
  const [issuer, ...parts] = String(value).split(";").map((part) => part.trim());
  const parameters = Object.fromEntries(parts.filter(Boolean).map((part) => {
    const equals = part.indexOf("=");
    return equals < 0 ? [part, ""] : [part.slice(0, equals).trim(), part.slice(equals + 1).trim()];
  }));
  return { issuer: issuer.toLowerCase(), parameters };
}

/**
 * Checks the domain's DNS. Resolves with { ok, relayAddresses, records,
 * checks: [{ id, ok, problem, found }] } where `found` holds only DNS
 * values (addresses, record text), nothing about the household.
 * Injected for tests: `resolver` (resolve4, resolve6, resolveCname,
 * resolveTxt, resolveCaa) and `ech(name)`.
 */
export async function checkDomainRecords({ domain, relayHost, publicKey, accountUrl, resolver = new Resolver({ timeout: 5_000, tries: 2 }), ech = publishesEch }) {
  const [relay4, relay6] = await Promise.all([lookup(() => resolver.resolve4(relayHost)), lookup(() => resolver.resolve6(relayHost))]);
  const relayAddresses = [...relay4.values, ...relay6.values];
  const records = expectedRecords({ domain, relayAddresses, publicKey, accountUrl });
  const checks = [];
  if (!relayAddresses.length) checks.push({ id: "relay", ok: false, problem: relay4.error || relay6.error ? "dns-unavailable" : "dns-relay-unknown", found: [] });

  const [cname, a, aaaa, txt, caa, echPublished] = await Promise.all([
    lookup(() => resolver.resolveCname(domain)),
    lookup(() => resolver.resolve4(domain)),
    lookup(() => resolver.resolve6(domain)),
    lookup(() => resolver.resolveTxt(`_kin-relay.${domain}`)),
    lookup(() => resolver.resolveCaa(domain)),
    Promise.resolve(ech(domain)).catch(() => null),
  ]);

  // A and AAAA: present, every one of them the relay's, and no CNAME.
  const addresses = [...a.values, ...aaaa.values];
  let addressProblem = null;
  if (cname.values.length) addressProblem = "dns-cname";
  else if (a.error && aaaa.error) addressProblem = "dns-unavailable";
  else if (!addresses.length) addressProblem = "dns-address-missing";
  else if (!relayAddresses.length) addressProblem = "dns-relay-unknown";
  else if (addresses.some((address) => !relayAddresses.includes(address))) addressProblem = "dns-address-wrong";
  checks.push({ id: "address", ok: addressProblem === null, problem: addressProblem, found: cname.values.length ? cname.values : addresses });

  // TXT: one of the strings is this key's hash.
  const wanted = keyHashText(publicKey);
  const strings = txt.values.map((chunks) => chunks.join("").trim());
  checks.push({ id: "txt", ok: strings.includes(wanted), problem: strings.includes(wanted) ? null : txt.error ? "dns-unavailable" : "dns-txt-missing", found: strings });

  // CAA: Let's Encrypt for this account only. Another `issue` entry would
  // let another CA or account issue for the name.
  const issues = caa.values.filter((record) => typeof record.issue === "string").map((record) => parseIssue(record.issue));
  const ours = (entry) => entry.issuer === "letsencrypt.org" && entry.parameters.accounturi === accountUrl;
  let caaProblem = null;
  if (caa.error && !caa.values.length) caaProblem = "dns-unavailable";
  else if (!issues.some(ours)) caaProblem = "dns-caa-missing";
  else if (!issues.every(ours)) caaProblem = "dns-caa-other";
  checks.push({ id: "caa", ok: caaProblem === null, problem: caaProblem, found: caa.values.map((record) => Object.entries(record).filter(([key]) => key !== "critical").map(([key, value]) => `${record.critical ?? 0} ${key} "${value}"`).join("")) });

  // HTTPS: no ECH configuration. Unknown is reported but doesn't block.
  checks.push({ id: "ech", ok: echPublished !== true, problem: echPublished === true ? "dns-ech" : null, found: [], unknown: echPublished === null });

  return { ok: checks.every((check) => check.ok), relayAddresses, records, checks };
}
