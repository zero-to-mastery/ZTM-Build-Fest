// The unlocked-session capture/check used by every asynchronous household
// operation. A session is the security generation plus the vault, store and
// engine that existed when the operation started; any lock, reopen or engine
// change in between makes it stale so late results are dropped.
import { VaultError } from "../../security/local-vault.js";

export function captureSession(host) {
  return {
    generation: host.securityGeneration,
    vault: host.vault,
    store: host.store,
    engine: host.engine,
  };
}

export function isCurrentSession(host, session) {
  return (
    session.generation === host.securityGeneration &&
    session.vault === host.vault &&
    Boolean(session.vault) &&
    !session.vault.locked &&
    // A session captured before the store or engine existed (early in
    // unlock) has no such key; only keys present are compared.
    (!Object.hasOwn(session, "store") || session.store === host.store) &&
    (!Object.hasOwn(session, "engine") || session.engine === host.engine)
  );
}

export function assertCurrentSession(host, session) {
  if (!isCurrentSession(host, session))
    throw new VaultError("Kin was locked or reopened during the operation.", "locked");
}

export function reconnectLostAuthorization(authorization, wasBound) {
  return authorization?.loaded === true && wasBound && !authorization.identity;
}
