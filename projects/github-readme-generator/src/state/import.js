import { networkMessage, rateLimitMessage } from "./network-errors.js";
import { githubUsername } from "./github-profile.js";
export const IMPORT_LIMIT = 2_000_000;
export function githubRepository(input) {
  let value = String(input).trim().replace(/^@/, "");
  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Enter a username or owner/repository.");
    }
    if (
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error("Enter a GitHub profile or repository URL.");
    value = url.pathname.replace(/^\/|\/$/g, "");
  }
  const parts = value.split("/");
  if (
    parts.length > 2 ||
    !parts.every((p) => /^[\w.-]+$/.test(p) && ![".", ".."].includes(p))
  )
    throw new Error("Enter a username or owner/repository.");
  const owner = githubUsername(parts[0]);
  return { owner, repository: parts[1] || owner };
}
export async function boundedText(response, limit = IMPORT_LIMIT) {
  if (Number(response.headers?.get("content-length")) > limit)
    throw new Error("Import exceeds the 2 MB Markdown limit.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  if (!response.body?.getReader) {
    const value = await response.text();
    if (new TextEncoder().encode(value).length > limit)
      throw new Error("Import exceeds the 2 MB Markdown limit.");
    return value;
  }
  const reader = response.body.getReader();
  let size = 0,
    text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Import exceeds the 2 MB Markdown limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
export async function importGithub(input, fetcher = fetch, cancellation) {
  const { owner, repository } = githubRepository(input);
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const controller = new AbortController();
  const cancel = () => controller.abort(cancellation.reason);
  if (cancellation?.aborted) cancel();
  else cancellation?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(new DOMException("GitHub timed out.", "TimeoutError")),
    20000,
  );
  const request = async (path, kind, raw = false) => {
    controller.signal.throwIfAborted();
    let response;
    try {
      response = await fetcher(base + path, {
        headers: {
          Accept: raw
            ? "application/vnd.github.raw+json"
            : "application/vnd.github.object+json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(networkMessage());
    }
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? kind === "repository"
            ? "Repository not found or not public."
            : "Repository exists, but no public README was found."
          : [403, 429].includes(response.status)
            ? rateLimitMessage(response)
            : `GitHub API error (${response.status}).`,
      );
    const source = await boundedText(response, raw ? IMPORT_LIMIT : 3_000_000);
    if (raw) return source;
    try {
      return JSON.parse(source);
    } catch {
      throw new Error("GitHub returned malformed metadata. Try again.");
    }
  };
  try {
    const repo = await request("", "repository");
    if (
      !repo ||
      typeof repo.default_branch !== "string" ||
      !repo.default_branch
    )
      throw new Error("GitHub returned malformed repository metadata.");
    const ref = repo.default_branch;
    const path = `/readme?ref=${encodeURIComponent(ref)}`;
    const file = await request(path, "readme");
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path ||
      typeof file.sha !== "string" ||
      !file.sha ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new Error("GitHub returned malformed README metadata.");
    if (file.size > IMPORT_LIMIT)
      throw new Error("Import exceeds the 2 MB Markdown limit.");
    let markdown;
    if (file.encoding === "base64" && typeof file.content === "string") {
      try {
        markdown = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(
          Uint8Array.from(atob(file.content.replace(/\s/g, "")), (c) =>
            c.charCodeAt(0),
          ),
        );
      } catch {
        throw new Error(
          "GitHub returned malformed README content or invalid UTF-8.",
        );
      }
    } else if (file.encoding === "none") {
      markdown = await request(path, "readme", true);
      const verify = await request(path, "readme");
      if (verify?.sha !== file.sha)
        throw new Error(
          "Remote README changed during import. Preview the import again.",
        );
    } else
      throw new Error("GitHub returned malformed README content metadata.");
    const bytes = new TextEncoder().encode(markdown).length;
    if (bytes > IMPORT_LIMIT)
      throw new Error("Import exceeds the 2 MB Markdown limit.");
    if (bytes !== file.size)
      throw new Error(
        "GitHub returned incomplete README content. Preview the import again.",
      );
    return {
      name: `${owner}/${repository}`,
      markdown,
      repository: `${owner}/${repository}`,
      metadata: {
        repository: `${owner}/${repository}`,
        importSource: {
          type: "github",
          owner,
          repository,
          ref,
          readmePath: file.path,
          sha: file.sha,
          fetchedAt: new Date().toISOString(),
        },
      },
    };
  } catch (error) {
    if (cancellation?.aborted) throw cancellation.reason;
    if (controller.signal.aborted)
      throw new Error("GitHub timed out. Try again or import a local file.");
    throw error;
  } finally {
    clearTimeout(timeout);
    cancellation?.removeEventListener("abort", cancel);
  }
}
export function sourceChange(previous, next) {
  if (
    previous?.type !== "github" ||
    previous.owner !== next?.owner ||
    previous.repository !== next?.repository
  )
    return "";
  return previous.sha && next.sha
    ? previous.sha === next.sha
      ? "No remote changes"
      : "Remote README has changed"
    : "Remote version could not be compared";
}
