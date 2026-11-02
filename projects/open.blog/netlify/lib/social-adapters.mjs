// The provider adapters this deployment delivers through (epic #353, ADRs 0316 and 0319). The
// worker (social-worker.mjs) calls a provider only through the interface in social-delivery.mjs and
// asks this module which providers it has an adapter for. An adapter is registered only for a
// provider that socialProviders(env) reports as configured (client id, secret and a valid API
// version), so delivery to a provider is off until the deployer sets it up. A provider that is not
// here is not guessed at: its announcements wait in the queue (ADR 0317).
//
// `providers` is socialProviders(env): its secrets are not enumerable and never reach an adapter's
// output or a log. `fetchImpl` and `now` are injected so the adapters are tested against fakes.

import { ADAPTER_FACTORIES } from "./social-publish.mjs";

export function socialAdapters({ providers = {}, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const adapters = Object.create(null);
  for (const [provider, factory] of Object.entries(ADAPTER_FACTORIES)) {
    const settings = Object.hasOwn(providers, provider) ? providers[provider] : null;
    if (!settings || settings.provider !== provider || typeof settings.apiBase !== "string" || typeof settings.version !== "string") continue;
    adapters[provider] = factory(settings, { fetchImpl, now });
  }
  return Object.freeze(adapters);
}
