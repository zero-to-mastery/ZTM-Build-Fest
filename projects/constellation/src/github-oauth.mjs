// Only the short-lived PKCE transaction survives the authorization redirect.
// Access tokens remain exclusively in createGitHubSession's page memory.
const KEY = 'constellation-oauth-transaction';
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export function createGitHubOAuth({ clientId, exchangeUrl, redirectUri, storage, cryptoImpl = crypto, fetchImpl = fetch, now = Date.now }) {
  let revision = 0;
  const clear = () => { revision++; storage.removeItem(KEY); };
  function configuration() {
    if (!clientId || !exchangeUrl) throw Error('GitHub sign-in is not configured. Explore a public account or see the deployment guide.');
    const endpoint = new URL(exchangeUrl), callback = new URL(redirectUri);
    const secure = url => url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (!clientId || !secure(endpoint) || !secure(callback) || endpoint.username || endpoint.password || callback.search || callback.hash) throw Error('GitHub sign-in is not configured. Explore a public account or see the deployment guide.');
  }
  return {
    cancel: clear,
    async begin() {
      configuration(); clear();
      const attempt = revision;
      const state = base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
      const verifier = base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      if (attempt !== revision) throw Error('Sign-in cancelled.');
      storage.setItem(KEY, JSON.stringify({ state, verifier, created: now(), redirectUri }));
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' });
      return url.href;
    },
    async complete(href) {
      const callback = new URL(href);
      if (!callback.searchParams.has('code') && !callback.searchParams.has('error')) return null;
      let transaction;
      try { transaction = JSON.parse(storage.getItem(KEY)); } catch {}
      clear(); const attempt = revision;
      if (!transaction || callback.searchParams.get('state') !== transaction.state || transaction.redirectUri !== redirectUri || callback.origin + callback.pathname !== redirectUri || now() - transaction.created > 600000 || now() < transaction.created) throw Error('GitHub sign-in expired or state did not match. Start again.');
      if (callback.searchParams.has('error')) throw Error(callback.searchParams.get('error') === 'access_denied' ? 'GitHub sign-in cancelled. You can explore a public account.' : 'GitHub could not authorize this request. Start again.');
      configuration();
      const response = await fetchImpl(exchangeUrl, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ code: callback.searchParams.get('code'), code_verifier: transaction.verifier }) });
      if (!response.ok) throw Error('GitHub sign-in could not be completed. Start again.');
      const body = await response.json();
      if (attempt !== revision) return null;
      if (typeof body.access_token !== 'string' || !body.access_token || /\s/.test(body.access_token)) throw Error('Invalid GitHub sign-in response.');
      return body.access_token;
    },
  };
}
