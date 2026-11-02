import { healthTargets, checkTarget } from "../github/health.js";
import { cachedHealth, cacheHealth } from "../github/health-cache.js";
import { sourceHash } from "../state/source-hash.js";

import { finding, historyFindings } from "./signals.js";

// `reviewedAt` is when the checks finished; plans cite it for link, image and
// history evidence instead of the time the audit read the README.
export async function reviewReadme(repo, readme, options = {}) {
  const review = await checks(repo, readme, options);
  return { ...review, reviewedAt: options.client.now() };
}

async function checks(repo, readme, { client, signal } = {}) {
  const findings = [],
    notes = [];
  if (readme.source === null)
    return {
      findings,
      notes: ["No root README to inspect."],
      historyChecked: false,
      linksChecked: false,
    };
  let historyChecked = false;
  try {
    const history = await client.history(repo, readme.path, { signal });
    historyChecked = true;
    findings.push(
      ...historyFindings(history.updated, history.commits, client.now()),
    );
    notes.push(
      history.updated
        ? `README history observed at ${history.updated}; sampled at most 30 recent commits. History is advisory, not proof of correctness.`
        : "README modification date could not be discovered.",
    );
  } catch (error) {
    signal?.throwIfAborted();
    notes.push(`History not assessed: ${error.message}`);
    if (["rate-limit", "forbidden"].includes(error.kind))
      return {
        findings,
        historyChecked,
        linksChecked: false,
        notes: [
          ...notes,
          "Link checks skipped after GitHub restricted requests.",
        ],
      };
  }
  const [owner, repository] = repo.full_name.split("/");
  const targets = healthTargets({
    blocks: [{ type: "custom", settings: { markdown: readme.source } }],
    metadata: {
      importSource: {
        type: "github",
        owner,
        repository,
        ref: repo.default_branch || "HEAD",
        readmePath: readme.path,
      },
    },
  });
  let checked = 0,
    unknown = 0;
  // One review at a time in the UI; serial URL checks avoid multiplying batch concurrency.
  for (const target of targets.slice(0, 20)) {
    signal?.throwIfAborted();
    const result =
      cachedHealth(target) ||
      (await checkTarget(target, { signal, fetcher: client.fetcher }));
    signal?.throwIfAborted();
    cacheHealth(target, result);
    checked++;
    if (result.state === "not found")
      findings.push(
        finding(
          `${target.image ? "image" : "link"}:unavailable:${sourceHash(target.url)}`,
          `${target.image ? "Image" : "Link"} unavailable: ${target.url} (HTTP 404/410 at check time).`,
          { url: target.url },
        ),
      );
    else if (!["reachable", "redirected"].includes(result.state)) unknown++;
    if (result.state === "rate limited") {
      notes.push("Link checks stopped at a rate limit. Retry later.");
      break;
    }
  }
  notes.push(
    `${checked} links/images checked; ${unknown} unverifiable. ${targets.length > checked ? "Additional URLs were not checked (20 per review maximum)." : ""} Browser policy and network failures do not prove broken links.`,
  );
  return {
    findings,
    notes,
    historyChecked,
    linksChecked: unknown === 0 && checked === targets.length,
  };
}
