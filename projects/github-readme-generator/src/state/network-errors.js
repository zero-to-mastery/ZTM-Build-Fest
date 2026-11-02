export function networkMessage() {
  return globalThis.navigator?.onLine === false
    ? "You are offline. Editing and local export still work; reconnect to use GitHub."
    : "Could not reach GitHub. Check your connection and try again.";
}
export function rateLimitMessage(response) {
  const raw = response.headers?.get?.("x-ratelimit-reset");
  const retry = response.headers?.get?.("retry-after");
  const date = raw
    ? new Date(Number(raw) * 1000)
    : retry
      ? new Date(
          /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : retry,
        )
      : null;
  return `GitHub rate limit reached.${date && !Number.isNaN(date.getTime()) ? ` Try again after ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : " Try again later."} You can still import a local file.`;
}
