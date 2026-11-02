// Credentials live only in this page's memory, never in designs or storage.
export function createGitHubSession({ fetchImpl = fetch, onChange = () => {} } = {}) {
  let token = '', profile = null, revision = 0;
  const signOut = () => { revision++; token = ''; profile = null; onChange(null); };
  const request = async (url, options = {}) => {
    const target = new URL(url), credential = token;
    if (target.origin !== 'https://api.github.com' || target.username || target.password) {
      const headers = new Headers(options.headers); headers.delete('Authorization');
      return fetchImpl(url, { ...options, headers });
    }
    const headers = new Headers(options.headers);
    headers.delete('Authorization');
    if (credential) headers.set('Authorization', `Bearer ${credential}`);
    const response = await fetchImpl(url, { ...options, headers, redirect: 'error', credentials: 'omit' });
    if (response.status === 401 && token === credential) signOut();
    return response;
  };
  return {
    get token() { return token; },
    get profile() { return profile; },
    fetch: request, signOut,
    cancelSignIn() { revision++; },
    async signIn(value) {
      const attempt = ++revision, candidate = String(value || '').trim();
      if (!candidate || /\s/.test(candidate)) throw new Error('Enter a valid GitHub token.');
      let response;
      try {
        response = await fetchImpl('https://api.github.com/user', {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${candidate}` },
          credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000),
        });
      } catch { throw new Error('Could not reach GitHub. Try again.'); }
      if (!response.ok) throw new Error(response.status === 401 ? 'GitHub rejected this token. Check that it has not expired or been revoked.' : 'GitHub could not verify this token. Check its access and try again.');
      const user = await response.json();
      if (!/^[a-z\d][a-z\d-]{0,38}$/i.test(user.login || '')) throw new Error('GitHub returned an invalid account.');
      if (attempt !== revision) return null;
      token = candidate; profile = { login: user.login, ...(typeof user.name === 'string' ? { name: user.name.slice(0, 200) } : {}), ...(typeof user.avatar_url === 'string' && user.avatar_url.startsWith('https://avatars.githubusercontent.com/') ? { avatar: user.avatar_url } : {}) };
      onChange(profile);
      return profile;
    },
  };
}
