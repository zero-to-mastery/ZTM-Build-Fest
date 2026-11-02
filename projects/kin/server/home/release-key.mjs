// The public half of Kin's release key (ADR 0025 §10, #722), as the 32-byte
// Ed25519 public key in base64. The owner makes the key pair on an offline
// computer with scripts/release/release-key.mjs, keeps the private key there,
// and puts the printed public key here. While this is null, home servers
// don't check for updates: the control panel says updates are off in this
// build.
export const RELEASE_PUBLIC_KEY = null;
