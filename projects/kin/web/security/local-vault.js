// Browser capabilities only. Canonical household interpretation remains in Rust.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_VALUE_BYTES = 64 * 1024 * 1024;
const MAX_WRAPPERS = 16;
let activeVault = null;
let nextGeneration = 1;

export class VaultError extends Error {
  constructor(message, code = "vault_invalid", cause) {
    super(message, { cause });
    this.name = "VaultError";
    this.code = code;
    this.userMessage = message;
  }
}

export function getActiveVault() {
  activeVault?.assertUnlocked();
  return activeVault;
}

export function setActiveVault(vault) {
  if (activeVault && activeVault !== vault) activeVault.lock();
  activeVault = vault;
}

export function randomRecoverySecret() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export function parseRecoverySecret(value) {
  const normalized = String(value).trim().replaceAll("-", "").replaceAll(" ", "");
  if (!/^[a-fA-F0-9]{64}$/.test(normalized))
    throw new VaultError("Enter the complete 64-character recovery key.", "recovery_invalid");
  return Uint8Array.from(normalized.match(/../g), (part) => Number.parseInt(part, 16));
}

export class LocalVault {
  constructor(vaultId, root, manifest) {
    if (!/^[a-f0-9]{32}$/.test(vaultId) || root.byteLength !== 32 ||
        manifest?.vaultId !== vaultId || !validRootFormat(manifest))
      throw new VaultError("The household security metadata is invalid.");
    this.vaultId = vaultId;
    this.rootVersion = manifest.rootVersion;
    this.root = root.slice();
    this.manifest = structuredClone(manifest);
    this.generation = nextGeneration++;
    this.locked = false;
    this.listeners = new Set();
  }

  static async create(recoverySecret = randomRecoverySecret()) {
    requireCrypto();
    return LocalVault.createRoot(recoverySecret, hex(crypto.getRandomValues(new Uint8Array(16))), 1);
  }

  static async createRotation(sourceVault, recoverySecret = randomRecoverySecret()) {
    sourceVault.assertUnlocked();
    if (sourceVault.rootVersion >= Number.MAX_SAFE_INTEGER)
      throw new VaultError("Kin cannot advance this household's protection further.");
    const candidate = await LocalVault.createRoot(recoverySecret, sourceVault.vaultId, sourceVault.rootVersion + 1);
    try {
      sourceVault.assertUnlocked();
      return candidate;
    } catch (error) { candidate.vault.lock(); throw error; }
  }

  static async createRoot(recoverySecret, vaultId, rootVersion) {
    requireCrypto();
    const root = crypto.getRandomValues(new Uint8Array(32));
    const manifest = { formatVersion: rootVersion === 1 ? 1 : 2, vaultId, rootVersion, wrappers: [] };
    const vault = new LocalVault(vaultId, root, manifest);
    root.fill(0);
    let secret;
    try {
      secret = parseRecoverySecret(recoverySecret);
      manifest.wrappers.push(await vault.createWrapper(secret, { type: "recovery" }));
      manifest.verifier = await vault.seal("kin-vault-check-v1", { store: "security", id: "verifier" });
      vault.manifest = structuredClone(manifest);
      // Verify the recovery path before returning anything eligible for persistence.
      const verified = await LocalVault.unlock(manifest, recoverySecret);
      verified.lock();
      return { vault, manifest, recoverySecret };
    } catch (error) {
      vault.lock();
      throw error;
    } finally {
      secret?.fill(0);
    }
  }

  static async unlock(manifest, secret, wrapperId = null) {
    requireCrypto();
    validateManifest(manifest);
    const wrapper = manifest.wrappers.find((entry) => wrapperId ? entry.id === wrapperId : entry.type === "recovery");
    if (!wrapper) throw new VaultError("This household has no matching unlock path.", "wrapper_unavailable");
    const bytes = typeof secret === "string" ? parseRecoverySecret(secret) : new Uint8Array(secret).slice();
    let root;
    let vault;
    try {
      if (bytes.byteLength !== 32) throw new Error("secret length");
      root = await decryptBytes(bytes, wrapper.sealed, manifest.vaultId, "kin/local-wrapper/v1", wrapperContext(wrapper), manifest.rootVersion);
      if (root.byteLength !== 32) throw new Error("root length");
      vault = new LocalVault(manifest.vaultId, root, manifest);
      if (await vault.open(manifest.verifier, { store: "security", id: "verifier" }) !== "kin-vault-check-v1")
        throw new Error("verifier");
      return vault;
    } catch (error) {
      vault?.lock();
      throw new VaultError("Kin could not unlock this household. Check the credential or recovery key; saved data was not changed.", "unlock_failed", error);
    } finally {
      bytes.fill(0);
      root?.fill(0);
    }
  }

  assertUnlocked() {
    if (this.locked || this.root === null)
      throw new VaultError("Kin is locked. Unlock before using household information.", "locked");
  }

  onLock(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  lock() {
    if (this.locked) return;
    this.locked = true;
    this.generation = nextGeneration++;
    this.root?.fill(0);
    this.root = null;
    if (activeVault === this) activeVault = null;
    for (const callback of this.listeners) {
      try { callback(); } catch { /* Other capabilities must still be revoked. */ }
    }
    this.listeners.clear();
  }

  async seal(value, context) {
    this.assertUnlocked();
    const generation = this.generation;
    const plaintext = serializeProtectedValue(value);
    try {
      const envelope = await encryptBytes(this.root, plaintext, this.vaultId, "kin/local-storage/v1", valueContext(context), this.rootVersion);
      this.assertUnlocked();
      if (generation !== this.generation) throw new VaultError("Kin was locked during the operation.", "locked");
      return envelope;
    } finally {
      plaintext.fill(0);
    }
  }

  async open(envelope, context) {
    this.assertUnlocked();
    const generation = this.generation;
    let plaintext;
    try {
      plaintext = await decryptBytes(this.root, envelope, this.vaultId, "kin/local-storage/v1", valueContext(context), this.rootVersion);
      this.assertUnlocked();
      if (generation !== this.generation) throw new VaultError("Kin was locked during the operation.", "locked");
      return deserializeProtectedValue(plaintext);
    } catch (error) {
      if (error.code === "locked") throw error;
      throw new VaultError("Kin could not verify the protected store. Saved information was not changed.", "protected_store_corrupt", error);
    } finally {
      plaintext?.fill(0);
    }
  }

  async createWrapper(secret, { type, id = hex(crypto.getRandomValues(new Uint8Array(16))), credentialId, prfSalt } = {}) {
    this.assertUnlocked();
    if (!["recovery", "prf"].includes(type) || new Uint8Array(secret).byteLength !== 32)
      throw new VaultError("The unlock mechanism is invalid.");
    if (type === "prf" && (!credentialId || !prfSalt))
      throw new VaultError("The passkey wrapper is incomplete.");
    const wrapper = { version: 1, id, type };
    if (type === "prf") Object.assign(wrapper, { credentialId, prfSalt });
    wrapper.sealed = await encryptBytes(secret, this.root, this.vaultId, "kin/local-wrapper/v1", wrapperContext(wrapper), this.rootVersion);
    this.assertUnlocked();
    return wrapper;
  }

  async addCredentialWrapper(secret, { credentialId, prfSalt }) {
    this.assertUnlocked();
    if (this.manifest.wrappers.length >= MAX_WRAPPERS)
      throw new VaultError("This household has reached its unlock-path limit.");
    if (this.manifest.wrappers.some((wrapper) => wrapper.credentialId === credentialId))
      throw new VaultError("This passkey already unlocks the household.");
    const wrapper = await this.createWrapper(secret, { type: "prf", credentialId, prfSalt });
    const candidate = { ...this.manifest, wrappers: [...this.manifest.wrappers, wrapper] };
    const verified = await LocalVault.unlock(candidate, secret, wrapper.id);
    verified.lock();
    this.assertUnlocked();
    this.manifest = candidate;
    return structuredClone(candidate);
  }

  removeWrapper(id) {
    this.assertUnlocked();
    const wrappers = this.manifest.wrappers.filter((wrapper) => wrapper.id !== id);
    if (wrappers.length === this.manifest.wrappers.length) throw new VaultError("That unlock path was not found.");
    if (wrappers.length === 0 || !wrappers.some((wrapper) => wrapper.type === "recovery"))
      throw new VaultError("Keep a verified recovery path before removing this unlock method.", "last_wrapper");
    this.manifest = { ...this.manifest, wrappers };
    return structuredClone(this.manifest);
  }

  async sealArchive(value, metadata = new Uint8Array(), { rawCiphertext = false } = {}) {
    this.assertUnlocked();
    const bytes = serializeProtectedValue(value);
    try {
      const result = await encryptBytes(this.root, bytes, this.vaultId, "kin/archive/v1", ["archive", "1", toBase64Url(metadata)], 1, rawCiphertext);
      this.assertUnlocked();
      return result;
    } finally { bytes.fill(0); }
  }

  async openArchive(envelope, metadata = new Uint8Array(), { ownedCiphertext = false } = {}) {
    this.assertUnlocked();
    // The archive adapter transfers its private copied ciphertext buffer. Other
    // callers keep the established immutable base64 representation by default.
    const bytes = await decryptBytes(this.root, envelope, this.vaultId, "kin/archive/v1", ["archive", "1", toBase64Url(metadata)], 1, ownedCiphertext);
    try {
      this.assertUnlocked();
      return deserializeProtectedValue(bytes);
    } finally { bytes.fill(0); }
  }
}

function requireCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues)
    throw new VaultError("This browser does not support secure local storage. Use a secure context and a supported browser.", "unsupported_unlock");
}

function validRootFormat(manifest) {
  return (manifest?.formatVersion === 1 && manifest.rootVersion === 1) ||
    (manifest?.formatVersion === 2 && Number.isSafeInteger(manifest.rootVersion) && manifest.rootVersion >= 2);
}

function validateManifest(manifest) {
  if (!validRootFormat(manifest) || !/^[a-f0-9]{32}$/.test(manifest.vaultId) ||
      !Array.isArray(manifest.wrappers) || !manifest.wrappers.length || manifest.wrappers.length > MAX_WRAPPERS)
    throw new VaultError("The household security format is unsupported or corrupt.");
  const ids = new Set();
  for (const wrapper of manifest.wrappers) {
    if (wrapper?.version !== 1 || !/^[a-f0-9]{32}$/.test(wrapper.id) || !["recovery", "prf"].includes(wrapper.type) || ids.has(wrapper.id))
      throw new VaultError("The household unlock metadata is invalid.");
    ids.add(wrapper.id);
  }
}

function valueContext({ store, id } = {}) {
  if (typeof store !== "string" || !store || store.length > 128 || id === undefined)
    throw new VaultError("The protected record context is invalid.");
  return [store, toBase64Url(serializeProtectedValue(id))];
}

function wrapperContext(wrapper) {
  return [wrapper.type, wrapper.id, wrapper.credentialId ?? "", wrapper.prfSalt ?? ""];
}

function fields(values) {
  // JSON string-array encoding is length-unambiguous; never concatenate raw IDs.
  return encoder.encode(JSON.stringify(values));
}

async function deriveKey(secret, salt, purpose, vaultId, context) {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: fields([purpose, vaultId, ...context]) },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

async function encryptBytes(secret, bytes, vaultId, purpose, context, rootVersion = 1, rawCiphertext = false) {
  if (bytes.byteLength > MAX_VALUE_BYTES) throw new VaultError("The protected record exceeds Kin's supported size.");
  // A fresh 256-bit salt derives a one-use AES key; the root is never an AES key.
  // The independently random 96-bit IV is never intentionally reused under a key.
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const version = rootVersion === 1 ? 1 : 2;
  const authenticatedContext = version === 1 ? context : ["root-version", String(rootVersion), ...context];
  const key = await deriveKey(secret, salt, purpose, vaultId, authenticatedContext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: fields([purpose, String(version), vaultId, ...authenticatedContext]), tagLength: 128 }, key, bytes,
  );
  return { version, ...(version === 2 ? { rootVersion } : {}), vaultId, salt: toBase64Url(salt), nonce: toBase64Url(nonce),
    ciphertext: rawCiphertext ? new Uint8Array(ciphertext) : toBase64Url(new Uint8Array(ciphertext)) };
}

async function decryptBytes(secret, envelope, vaultId, purpose, context, rootVersion = 1, ownedCiphertext = false) {
  const version = rootVersion === 1 ? 1 : 2;
  if (envelope?.version !== version || envelope.vaultId !== vaultId ||
      (version === 2 ? envelope.rootVersion !== rootVersion : envelope.rootVersion !== undefined))
    throw new VaultError("The protected record belongs to a different household or format.");
  const salt = fromBase64Url(envelope.salt);
  const nonce = fromBase64Url(envelope.nonce);
  const ciphertext = ownedCiphertext && envelope.ciphertext instanceof Uint8Array ? envelope.ciphertext : fromBase64Url(envelope.ciphertext);
  if (salt.length !== 32 || nonce.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_VALUE_BYTES + 16)
    throw new VaultError("The protected record has invalid bounds.");
  const authenticatedContext = version === 1 ? context : ["root-version", String(rootVersion), ...context];
  const key = await deriveKey(secret, salt, purpose, vaultId, authenticatedContext);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: fields([purpose, String(version), vaultId, ...authenticatedContext]), tagLength: 128 }, key, ciphertext,
  ));
}

export function serializeProtectedValue(value) {
  function pack(input, depth = 0) {
    if (depth > 64) throw new VaultError("The protected record is too deeply nested.");
    if (input === null || typeof input === "string" || typeof input === "boolean") return ["value", input];
    if (typeof input === "number" && Number.isFinite(input)) return ["value", input];
    if (typeof input === "bigint") return ["bigint", input.toString()];
    if (input === undefined) return ["undefined"];
    if (input instanceof Uint8Array) return ["bytes", toBase64Url(input)];
    if (input instanceof ArrayBuffer) return ["buffer", toBase64Url(new Uint8Array(input))];
    if (Array.isArray(input)) return ["array", input.map((entry) => pack(entry, depth + 1))];
    if (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
      return ["object", Object.entries(input).map(([key, entry]) => [key, pack(entry, depth + 1)])];
    throw new VaultError("The protected record contains an unsupported value.");
  }
  const bytes = encoder.encode(JSON.stringify(pack(value)));
  if (bytes.length > MAX_VALUE_BYTES) throw new VaultError("The protected record is too large.");
  return bytes;
}

export function deserializeProtectedValue(bytes) {
  if (bytes.byteLength > MAX_VALUE_BYTES) throw new VaultError("The protected record is too large.");
  function unpack(node, depth = 0) {
    if (depth > 64 || !Array.isArray(node) || node.length !== (node[0] === "undefined" ? 1 : 2)) throw new VaultError("The protected value is invalid.");
    switch (node[0]) {
      case "value":
        if (node[1] === null || ["string", "boolean"].includes(typeof node[1]) || (typeof node[1] === "number" && Number.isFinite(node[1]))) return node[1];
        break;
      case "undefined": return undefined;
      case "bigint": if (/^-?[0-9]{1,30}$/.test(node[1])) return BigInt(node[1]); break;
      case "bytes": return fromBase64Url(node[1]);
      case "buffer": return fromBase64Url(node[1]).buffer;
      case "array": if (Array.isArray(node[1])) return node[1].map((entry) => unpack(entry, depth + 1)); break;
      case "object": {
        if (!Array.isArray(node[1])) throw new VaultError("The protected object is invalid.");
        const result = {};
        for (const pair of node[1]) {
          if (!Array.isArray(pair) || pair.length !== 2) throw new VaultError("The protected object field is invalid.");
          const [key, entry] = pair;
          if (typeof key !== "string" || Object.hasOwn(result, key)) throw new VaultError("The protected object is invalid.");
          Object.defineProperty(result, key, { value: unpack(entry, depth + 1), enumerable: true, configurable: true, writable: true });
        }
        return result;
      }
    }
    throw new VaultError("The protected value type is unsupported.");
  }
  return unpack(JSON.parse(decoder.decode(bytes)));
}

export function toBase64Url(bytes) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value) {
  if (typeof value !== "string" || value.length > Math.ceil((MAX_VALUE_BYTES + 16) * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value))
    throw new VaultError("The protected encoding is invalid.");
  const result = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
  if (toBase64Url(result) !== value) throw new VaultError("The protected encoding is not canonical.");
  return result;
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
