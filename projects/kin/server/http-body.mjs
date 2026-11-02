// Request bodies, read with a byte limit enforced as they arrive.
//
// A declared Content-Length over the limit is refused before any body byte
// is read. A body without one (chunked) is counted while it streams and
// refused the moment it passes the limit, so at most `limit` bytes are ever
// buffered. A refused request gets 413 with `Connection: close`; its
// remaining bytes are read and discarded until the response closes the
// connection, so the client still receives the 413 instead of a reset.
import { PairingError } from "./pairing-service.mjs";

function tooLarge(message) {
  return new PairingError("request_too_large", message, 413);
}

function badRequest() {
  return new PairingError("invalid_request", "Kin could not understand that request.");
}

/** The whole body as one Buffer, at most `limit` bytes. */
export function readBody(request, response, limit, message = "That request is too large.") {
  const refuse = () => {
    response.setHeader("Connection", "close");
    request.resume();
    return tooLarge(message);
  };
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (!/^[0-9]{1,16}$/.test(declared))
      return Promise.reject(badRequest());
    if (Number(declared) > limit) return Promise.reject(refuse());
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        chunks.length = 0;
        reject(refuse());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

/** A JSON body of at most `limit` bytes; an empty body is `{}`. */
export async function readJsonBody(request, response, limit) {
  const bytes = await readBody(request, response, limit);
  try {
    return bytes.length ? JSON.parse(bytes) : {};
  } catch {
    throw badRequest();
  }
}
