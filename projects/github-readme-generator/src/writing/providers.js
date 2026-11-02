import { OUTPUT_LIMIT } from "./model.js";

function compatibleConnection(config) {
  let url;
  try {
    url = new URL(config.endpoint);
  } catch {
    throw Error("Enter the full chat/completions endpoint URL.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error(
      "Use HTTPS, or HTTP on localhost, without URL credentials, query or fragment.",
    );
  if (!url.pathname.endsWith("/chat/completions"))
    throw Error("Use an endpoint ending in /chat/completions.");
  if (
    typeof config.model !== "string" ||
    !config.model.trim() ||
    config.model.length > 200 ||
    /[\x00-\x1f]/.test(config.model)
  )
    throw Error("Enter a valid model identifier from your provider.");
  const key = config.key || "";
  if (
    typeof key !== "string" ||
    key.length > 4096 ||
    /[\x00-\x20\x7f]/.test(key)
  )
    throw Error("The API key contains invalid characters.");
  return { endpoint: url.href, model: config.model.trim(), key };
}

const compatible = {
  name: "Chat completions compatible provider",
  keyPolicy:
    "API key may be required by your provider; optional for unauthenticated servers.",
  connect: compatibleConnection,
  request(settings, messages) {
    return {
      headers: {
        "Content-Type": "application/json",
        ...(settings.key ? { Authorization: `Bearer ${settings.key}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        stream: false,
        store: false,
        max_completion_tokens: 8192,
      }),
    };
  },
  parse(data) {
    const choice = data?.choices?.[0],
      message = choice?.message;
    if (
      message?.refusal ||
      message?.tool_calls?.length ||
      message?.function_call ||
      choice?.finish_reason !== "stop"
    )
      throw Error(
        "Provider did not return a complete text proposal. Try a smaller selection or another model.",
      );
    if (
      typeof message?.content !== "string" ||
      !message.content.trim() ||
      message.content.length > OUTPUT_LIMIT
    )
      throw Error("Provider returned empty or oversized Markdown.");
    return message.content;
  },
};

// Adapters own protocol details. Document transformations never select a vendor.
export const providers = Object.freeze({
  compatible: Object.freeze(compatible),
  local: Object.freeze({
    ...compatible,
    name: "Local chat completions server",
    keyPolicy: "No API key is sent. Only a loopback destination is allowed.",
    connect(config) {
      const settings = compatibleConnection({ ...config, key: "" });
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(
          new URL(settings.endpoint).hostname,
        )
      )
        throw Error("The local provider requires a loopback endpoint.");
      return settings;
    },
  }),
  disabled: Object.freeze({
    name: "No AI — manual writing",
    keyPolicy: "No key required. Nothing is transmitted.",
    connect() {
      throw Error(
        "AI is disabled. Paste or edit Proposed, then review the diff.",
      );
    },
  }),
});
export function providerFor(id = "compatible") {
  if (!Object.hasOwn(providers, id)) throw Error("Unknown writing provider.");
  return providers[id];
}
export function connection(config) {
  const provider = config.provider || "compatible";
  const settings = providerFor(provider).connect(config);
  // Preserve the original public contract for callers without a provider selection.
  return config.provider ? { ...settings, provider } : settings;
}
