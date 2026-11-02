import { username } from './constellation.mjs';
import { normalizePublicEvents } from './activity.mjs';

export async function fetchPublicActivity(account, { token, fetchImpl = fetch, signal, accountType = 'user', asOf = new Date().toISOString() } = {}) {
  const events = [];
  try {
    const name = username(account);
    for (let page = 1; page <= 3; page++) {
      const response = await fetchImpl(`https://api.github.com/${accountType === 'organization' ? 'orgs' : 'users'}/${name}/events${accountType === 'organization' ? '' : '/public'}?per_page=100&page=${page}`, {
        signal: signal || AbortSignal.timeout(20000), redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!response.ok) return { asOf, events: [], diagnostic: `Public activity unavailable (HTTP ${response.status}). Rendering without activity; refresh later to retry.` };
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error('Invalid events response.');
      events.push(...body);
      if (body.length < 100) break;
    }
    const normalized = normalizePublicEvents(events);
    // Only claim coverage back to an event we actually received, even for capped feeds.
    return { asOf, events: normalized, coverageStart: normalized.at(-1)?.createdAt, diagnostic: '' };
  } catch { return { asOf, events: [], diagnostic: 'Public activity unavailable. Rendering without activity; refresh later to retry.' }; }
}
