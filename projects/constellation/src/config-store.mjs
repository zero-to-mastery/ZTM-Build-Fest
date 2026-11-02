import { parseConfig, serializeConfig } from './config-schema.mjs';

export function createConfigStore(storage) {
  const key = account => `constellation-config-v1:${account.toLowerCase()}`;
  const read = account => {
    try {
      const value = JSON.parse(storage?.getItem(key(account)) || '{}');
      if (value.version !== 1 || !Array.isArray(value.presets)) return { version: 1, presets: [] };
      return { version: 1, draft: value.draft, presets: value.presets.filter(p => typeof p.name === 'string') };
    } catch { return { version: 1, presets: [] }; }
  };
  const write = (account, value) => {
    try { if (!storage) return false; storage.setItem(key(account), JSON.stringify(value)); return true; } catch { return false; }
  };
  const valid = (value, account) => { try { const result = parseConfig(value, account); return result.account.toLowerCase() === account.toLowerCase() ? result : null; } catch { return null; } };
  const name = value => { const result = value.trim(); if (!result || result.length > 80) throw new Error('Preset names need 1–80 characters.'); return result; };
  return {
    library() {
      try {
        const accounts = Array.from({ length: storage?.length || 0 }, (_, index) => storage.key(index)).filter(key => key?.startsWith('constellation-config-v1:')).map(key => key.slice('constellation-config-v1:'.length));
        return accounts.flatMap(account => read(account).presets.filter(preset => valid(preset.config, account)).map(preset => ({ account, ...preset }))).sort((a, b) => a.name.localeCompare(b.name) || a.account.localeCompare(b.account));
      } catch { return []; }
    },
    draft: account => valid(read(account).draft, account),
    saveDraft(account, options) { return write(account, { ...read(account), draft: JSON.parse(serializeConfig(account, options)) }); },
    reset(account) { const value = read(account); delete value.draft; return write(account, value); },
    presets: account => read(account).presets.filter(p => valid(p.config, account)),
    savePreset(account, label, options) {
      const value = read(account), title = name(label);
      const presets = value.presets.filter(p => p.name !== title);
      if (presets.length >= 30) throw new Error('Keep up to 30 presets per account.');
      presets.push({ name: title, config: JSON.parse(serializeConfig(account, options)) });
      return write(account, { ...value, presets });
    },
    rename(account, before, after) {
      const value = read(account), title = name(after);
      if (value.presets.some(p => p.name === title && p.name !== before)) throw new Error('A preset already has that name.');
      return write(account, { ...value, presets: value.presets.map(p => p.name === before ? { ...p, name: title } : p) });
    },
    delete(account, title) { const value = read(account); return write(account, { ...value, presets: value.presets.filter(p => p.name !== title) }); },
  };
}
