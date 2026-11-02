// PairingService, a signed-in member's own account security (ADR 0018,
// #560/#571): adding a passkey to a password account, changing the
// password, and what the security settings show. The vault wrappers that go
// with each change live in account-vault-service.mjs; the routes
// (server.mjs) apply both in one transaction where they belong together.
//
// Every change here needs the member's current password, fresh (the
// password limits apply, passwords.mjs): a session alone, say from a
// browser left signed in, can't add a passkey or change the password.
import { hashAuthKey } from "../account-password.mjs";
import { decodeAuthKey, PASSWORD_ITERATIONS_MIN } from "./passwords.mjs";
import { normalizeMemberKind, PairingError } from "./shared.mjs";

const PASSKEY_TYPES = ["passkey", "password-passkey"];
/** Wrapper types a password or a passkey opens; a vault must keep one. */
const SIGN_IN_TYPES = ["password", "passkey", "password-passkey"];

const PASSWORD_ITERATIONS_MAX = 10_000_000;
const passwordFailed = () => new PairingError("password_incorrect", "That password didn't match. Check it and try again.", 401);

export const accountMethods = {
  /**
   * The new password parameters from a request body (`{ salt, iterations,
   * authKey }`, base64url), hashed: `{ salt, iterations, verifier,
   * updatedAt }`. Async (Argon2id). The username doesn't change.
   */
  async preparePasswordChange(body) {
    const authKey = decodeAuthKey(body?.authKey);
    const salt = typeof body?.salt === "string" && /^[A-Za-z0-9_-]{22}$/.test(body.salt) ? Buffer.from(body.salt, "base64url") : null;
    const iterations = body?.iterations;
    if (!authKey || salt?.length !== 16 || salt.toString("base64url") !== body.salt ||
        !Number.isSafeInteger(iterations) || iterations < PASSWORD_ITERATIONS_MIN || iterations > PASSWORD_ITERATIONS_MAX)
      throw new PairingError("password_invalid", "Kin could not read that password. Try again.", 400);
    try {
      return { salt: new Uint8Array(salt), iterations, verifier: await hashAuthKey(authKey), updatedAt: this.now() };
    } finally {
      authKey.fill(0);
    }
  },

  /** The session's member, who must have a password, and their current
   * password checked fresh (`currentAuthKey`). */
  async confirmAccountPassword(sessionToken, currentAuthKey, rateKey = "unknown") {
    const auth = this.authorize(sessionToken);
    if (!auth.member.password)
      throw new PairingError("password_required", "This account doesn't sign in with a password.", 409);
    if (!(await this.checkPassword(auth.member, currentAuthKey, [`member:${auth.member.id}`, `address:${rateKey}`]))) {
      this.audit("password_confirmation_failed", { householdId: auth.household.id, memberId: auth.member.id });
      throw passwordFailed();
    }
    // The session may have ended during the check.
    return this.authorize(sessionToken);
  },

  /** Replaces the session's member's password with `prepared`
   * (preparePasswordChange). The caller checked the current one. */
  setAccountPassword(auth, prepared) {
    auth.member.password = { ...prepared, username: auth.member.username };
    this.audit("password_changed", { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id });
    this.persistHousehold(auth.household.id);
    return { username: auth.member.username, salt: Buffer.from(prepared.salt).toString("base64url"), iterations: prepared.iterations };
  },

  /** Adds a verified passkey `credential` (webauthn.verifyRegistration) to
   * the session's member. From now on their admin-only actions ask for a
   * passkey instead of the password (confirmsWithPassword). */
  addAccountPasskey(auth, credential) {
    this.addCredential(auth.member.id, credential);
    auth.member.credentials.add(credential.id);
    this.audit("passkey_added", { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id });
    this.persistHousehold(auth.household.id);
    return { credentialId: credential.id };
  },

  /**
   * Whether a member set up the old way (a passkey, no username or
   * password) may move to an account (#575): every active member except a
   * Temporary one, who never has private storage or a vault (ADR 0019).
   */
  assertAccountMigratable(member) {
    if (member.password)
      throw new PairingError("account_exists", "Your account already has a username and password.", 409);
    if (normalizeMemberKind(member.kind) === "temporary")
      throw new PairingError("account_unavailable", "Guest members don't sign in with a username and password.", 409);
    if (!member.credentials?.size)
      throw new PairingError("passkey_required", "Confirm with your passkey to set up your account.", 409);
  },

  /**
   * Gives the session's member, set up the old way, the username and
   * password from `prepared` (preparePassword), after the route checked a
   * fresh assertion of their passkey (#575). Idempotent only in the sense
   * that a second try is refused (`account_exists`): the device then goes on
   * with the vault steps, using the password it already set.
   */
  migrateAccount(auth, prepared) {
    this.assertAccountMigratable(auth.member);
    this.assertUsernameAvailable(prepared.username);
    auth.member.username = prepared.username;
    auth.member.password = prepared;
    this.audit("account_migrated", { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id });
    this.persistHousehold(auth.household.id);
    return { username: prepared.username, salt: Buffer.from(prepared.salt).toString("base64url"), iterations: prepared.iterations };
  },

  /**
   * Removes one of the session's member's passkeys (hardening after #561),
   * once the route applied the vault change that goes with it in the same
   * transaction. `wrappers` is the vault's wrapper summary afterwards (null
   * without a vault). Never the last way in: a member without a password
   * keeps at least one passkey, and a vault keeps a wrapper a password or a
   * passkey opens (so a backup code is never the only one left), and no
   * wrapper may still name the removed passkey.
   */
  removeAccountPasskey(auth, credentialId, wrappers) {
    const id = typeof credentialId === "string" ? credentialId : "";
    if (!auth.member.credentials.has(id))
      throw new PairingError("passkey_not_found", "That passkey isn't on your account.", 404);
    if (!auth.member.password && auth.member.credentials.size <= 1)
      throw new PairingError("last_way_in", "This is your only way to sign in. Add another passkey or a password first.", 409);
    if (wrappers) {
      if (wrappers.some((wrapper) => PASSKEY_TYPES.includes(wrapper.type) && wrapper.params?.credentialId === id))
        throw new PairingError("vault_wrapper_rules", "That passkey still opens your account. Try again.", 409);
      if (!wrappers.some((wrapper) => SIGN_IN_TYPES.includes(wrapper.type)))
        throw new PairingError("last_way_in", "Keep your password or another passkey as a way into your account.", 409);
    }
    auth.member.credentials.delete(id);
    this.credentials.delete(id);
    this.audit("passkey_removed", { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id });
    this.persistHousehold(auth.household.id);
    return { removed: id, passkeys: [...auth.member.credentials] };
  },

  /**
   * What the security settings show about the session's member's account:
   * their username, whether they have a password, their passkeys' IDs, and
   * since when they've had a device here (for the calm offers, ADR 0018
   * section 7). `vaultWrappers` is account-vault-service summary(auth).
   */
  accountSecurityView(auth, vaultWrappers) {
    let memberSince = null;
    for (const device of this.devices.values())
      if (device.memberId === auth.member.id && (memberSince === null || device.trustedAt < memberSince)) memberSince = device.trustedAt;
    return {
      username: auth.member.username ?? null,
      password: Boolean(auth.member.password),
      // The current password's public parameters, so a device whose own
      // copy is older (the password changed elsewhere) derives the right keys.
      passwordParameters: this.passwordParameters(auth.member),
      passkeys: [...auth.member.credentials],
      // Temporary members get no account (#575); the others are invited.
      memberKind: normalizeMemberKind(auth.member.kind),
      memberSince,
      vault: vaultWrappers ? { wrappers: vaultWrappers } : null,
    };
  },
};
