// The report channel's requests (#632, #628, ADR 0021 §3). A report goes to
// the Kin service, which keeps it and, when its operator set it up, posts a
// copy (never the screenshot) to the project's issue tracker.
import { recordDiagnostic } from "../diagnostics/ring-buffer.js";

const JSON_HEADERS = Object.freeze({ "Content-Type": "application/json" });

/** Where reports go: { forwarding, trackerPublic }, or null when unknown
 * (offline). */
export async function fetchChannel(fetcher = globalThis.fetch) {
  try {
    const response = await fetcher("/api/feedback/channel", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return null;
    const value = await response.json();
    return { forwarding: value.forwarding === true, trackerPublic: typeof value.trackerPublic === "boolean" ? value.trackerPublic : null };
  } catch { return null; }
}

/** One sentence for the preview: where this report goes. */
export function destinationText(channel) {
  if (!channel) return "It goes to the Kin team, the people who run this Kin service. If they post reports to the project's issue tracker, the copy there never includes a screenshot, and it may be public.";
  if (!channel.forwarding) return "It goes to the Kin team, the people who run this Kin service, and stays on that service.";
  const audience = channel.trackerPublic === false
    ? "which only the Kin team can read"
    : "which anyone on the internet can read";
  return `It goes to the Kin team, and a copy without any screenshot is posted to the project's issue tracker, ${audience}.`;
}

/**
 * Sends one outbox item; resolves { status, value }. Rejects only when the
 * network failed (the outbox keeps the item then).
 */
export async function sendOutboxItem(item, fetcher = globalThis.fetch) {
  const response = await fetcher(item.signed ? "/api/feedback" : "/api/feedback/anonymous", {
    method: "POST", credentials: "same-origin", headers: JSON_HEADERS, body: JSON.stringify(item.body),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) recordDiagnostic("feedback_send_failed", { status: response.status });
  return { status: response.status, value };
}

/** The member's own reports and suggestions with their status. Throws a
 * plain error when they can't be loaded. */
export async function fetchMine(fetcher = globalThis.fetch) {
  const response = await fetcher("/api/feedback/mine", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw Object.assign(new Error("Kin couldn't load what you've sent. Try again when you're online."), { status: response.status });
  const value = await response.json();
  return Array.isArray(value.items) ? value.items : [];
}
