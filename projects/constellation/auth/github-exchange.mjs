// Portable fetch handler for a separate serverless service. No graph dependencies.
export async function exchange(request, env, fetchImpl = fetch) {
  const headers = { 'Cache-Control': 'no-store', 'Vary': 'Origin', 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' };
  const reply = (status, body) => Response.json(body, { status, headers });
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.GITHUB_REDIRECT_URI || !env.STUDIO_ORIGIN) return reply(503, { error: 'Auth service is not configured.' });
  if (request.headers.get('Origin') !== env.STUDIO_ORIGIN) return reply(403, { error: 'Forbidden origin.' });
  headers['Access-Control-Allow-Origin'] = env.STUDIO_ORIGIN;
  headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply(405, { error: 'POST required.' });
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply(415, { error: 'JSON required.' });
  let body;
  try {
    const reader = request.body.getReader(); let size = 0, text = ''; const decoder = new TextDecoder();
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2048) { await reader.cancel(); return reply(413, { error: 'Request too large.' }); } text += decoder.decode(value, { stream: true }); }
    body = JSON.parse(text + decoder.decode());
  } catch { return reply(400, { error: 'Invalid request.' }); }
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(body?.code || '') || !/^[a-zA-Z0-9._~-]{43,128}$/.test(body?.code_verifier || '')) return reply(400, { error: 'Invalid authorization code or verifier.' });
  try {
    const response = await fetchImpl('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, redirect_uri: env.GITHUB_REDIRECT_URI, code: body.code, code_verifier: body.code_verifier }) });
    const result = await response.json();
    if (!response.ok || result.error || typeof result.access_token !== 'string') return reply(400, { error: 'Authorization failed. Start again.' });
    // Never forward refresh tokens, secrets or upstream diagnostics.
    return reply(200, { access_token: result.access_token });
  } catch { return reply(502, { error: 'GitHub is unavailable. Start again.' }); }
}
export default { fetch: exchange };
