import { writingMessages } from "./model.js";
import { connection, providerFor } from "./providers.js";
export { connection } from "./providers.js";

async function boundedJson(response) {
  const limit = 512_000;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw Error("Provider response is too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("Provider returned no readable response.");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw Error("Provider response is too large.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw Error("Provider returned invalid JSON.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function generateWriting(
  config,
  input,
  { signal, fetcher = fetch, timeout = 60_000 } = {},
) {
  const settings = connection(config);
  const provider = providerFor(settings.provider);
  const messages = writingMessages(
    input.action,
    input.original,
    input.notes,
    input.context,
    input.variant,
  );
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeout);
  try {
    const response = await fetcher(settings.endpoint, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      ...provider.request(settings, messages),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        {
          401: "Authentication failed. Check your provider key.",
          403: "The provider denied access to this model or endpoint.",
          429: "Provider rate or usage limit reached. Retry later.",
          404: "Endpoint or model not found. Check the provider configuration.",
        }[response.status] ||
          `Provider request failed (HTTP ${response.status}). Try again later.`,
      );
    }
    const data = await boundedJson(response);
    const proposed = provider.parse(data);
    if (controller.signal.aborted) throw Error("Cancelled.");
    return proposed;
  } catch (error) {
    if (controller.signal.aborted)
      throw Error(
        timedOut
          ? "Writing request timed out. Your draft is unchanged."
          : "Writing request cancelled. Your draft is unchanged.",
      );
    if (error instanceof TypeError)
      throw Error(
        "Could not reach the provider. Check network access and its browser CORS settings.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
