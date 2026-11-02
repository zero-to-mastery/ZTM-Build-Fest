// Test helpers for HTTP calls that look like JSON calls. /api/sync/events
// takes and returns binary batches (web/sync/envelope-wire.js); a test still
// writes its push body as { events: [...] } and reads a pull page as an object.
import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../web/sync/envelope-wire.js";

/** Content-Type header and body for `body` sent to `path`. */
export function requestBody(path, method, body) {
  if (method === "POST" && path.split("?")[0] === "/api/sync/events" && Array.isArray(body?.events))
    return { headers: { "Content-Type": ENVELOPE_CONTENT_TYPE }, body: encodeEnvelopeBatch(body.events) };
  return body
    ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { headers: {}, body: undefined };
}

/** The response body: a decoded event page for binary, JSON otherwise. */
export async function responseBody(response) {
  const type = response.headers.get("content-type") ?? "";
  if (type.startsWith(ENVELOPE_CONTENT_TYPE)) return decodeEventPage(new Uint8Array(await response.arrayBuffer()));
  return type.includes("application/json") ? response.json() : null;
}
