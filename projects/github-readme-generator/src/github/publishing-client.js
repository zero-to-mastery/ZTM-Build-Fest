export class PublishingClient {
  // Injection points for tests; defaults use the browser's fetch and online state.
  constructor({
    fetchImpl = (...args) => fetch(...args),
    online = () => navigator.onLine,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.online = online;
  }
  async request(operation, body) {
    if (!this.online())
      throw new Error(
        "You are offline. Download your README or reconnect to publish.",
      );
    const remoteWrite = ["commit", "pull-request"].includes(operation);
    let response;
    try {
      response = await this.fetchImpl(`/api/publishing/${operation}`, {
        method: body ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: body
          ? {
              "Content-Type": "application/json",
              "X-Studio-CSRF": this.csrf || "",
            }
          : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw Object.assign(
        new Error(
          remoteWrite
            ? `The ${operation === "commit" ? "publishing" : "pull request"} response was lost. Do not retry yet; reconcile its recovery journal with GitHub first.`
            : "Publishing service unavailable. Your local draft and download are safe.",
        ),
        remoteWrite ? { ambiguous: true } : {},
      );
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw Object.assign(
        new Error(
          remoteWrite
            ? `The ${operation === "commit" ? "publishing" : "pull request"} response was unreadable. Do not retry yet; reconcile its recovery journal with GitHub first.`
            : "Publishing is not configured on this static deployment. Use Download README.",
        ),
        remoteWrite ? { ambiguous: true } : {},
      );
    }
    if (!response.ok)
      throw Object.assign(
        new Error(
          value.error || "Publishing failed. Download remains available.",
        ),
        {
          status: response.status,
          remote: value.remote,
          preflight: value.preflight,
          ambiguous: value.ambiguous === true,
          alreadyApplied: value.alreadyApplied === true,
          pullRequest: value.pullRequest,
        },
      );
    if (value.csrf) this.csrf = value.csrf;
    return value;
  }
}
