export function seedHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return hash >>> 0;
}

export function seededRandom(seed) {
  let state = seedHash(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function newSeed() {
  const bytes = new Uint32Array(2); globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(36)).join('-');
}

export function resolveSeed(account, options = {}) {
  const mode = options.seedMode || 'account';
  if (!['account', 'custom', 'random'].includes(mode)) throw new Error('Invalid seed mode.');
  if (options.seed !== undefined && (typeof options.seed !== 'string' || options.seed.length > 120)) throw new Error('Seed must be text of up to 120 characters.');
  if (mode !== 'account' && !options.seed) throw new Error('Custom/random seed mode needs a saved seed.');
  return mode === 'account' ? account.toLowerCase() : options.seed;
}
