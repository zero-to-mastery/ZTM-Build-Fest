const avatarCache = new Map();
const avatarPattern = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function accountSunMode(value = 'off') {
  if (!['off', 'sun', 'avatar', 'profile'].includes(value)) throw new Error('accountSun must be off, sun, avatar or profile.');
  return value;
}

// Avatar CDN requests do not consume GitHub API quota. Embed the bytes so SVGs
// also work as README images, offline, and when rasterized to PNG.
export function loadAccountAvatar(account, { fetcher = fetch } = {}) {
  if (!/^[a-z\d][a-z\d-]{0,38}$/i.test(account)) return Promise.resolve(null);
  const key = account.toLowerCase();
  if (!avatarCache.has(key)) {
    if (avatarCache.size >= 16) avatarCache.delete(avatarCache.keys().next().value);
    avatarCache.set(key, (async () => {
      try {
        const response = await fetcher(`https://avatars.githubusercontent.com/${key}?s=96`, {
          credentials: 'omit', signal: AbortSignal.timeout(8000),
        });
        const type = response.headers.get('content-type')?.split(';')[0];
        if (!response.ok || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 96000) return null;
        let binary = '';
        for (let i = 0; i < bytes.length; i += 4096) binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
        return `data:${type};base64,${btoa(binary)}`;
      } catch { return null; }
    })());
  }
  return avatarCache.get(key);
}

export function renderAccountSun(account, options, centerY, escape, semantic) {
  const mode = accountSunMode(options.accountSun);
  if (mode === 'off') return '';
  const compact = options.layout === 'compact', radius = compact ? 13 : 23;
  const source = options.accountData?.avatarData;
  const avatar = mode === 'avatar' && typeof source === 'string' && source.length <= 130000 && avatarPattern.test(source) ? source : null;
  const label = account.length > 22 ? `${account.slice(0, 20)}…` : account;
  const rays = mode === 'profile' && semantic ? semantic.rays.map((ray, i) => {
    const dimension = semantic.profile.dimensions[i];
    const description = `${ray.dimension}: ${dimension.evidence.map(e => `${e.repository}: ${e.reason}`).join('; ') || 'no evidence in selected repositories'}`;
    return `<g class="profile-segment" data-profile-dimension="${ray.dimension}" tabindex="0" role="button" aria-label="${escape(description)}"><title>${escape(description)}</title><path d="M${ray.start.join(' ')}L${ray.end.join(' ')}" stroke="currentColor" stroke-width="5" stroke-linecap="butt"/><text x="${ray.label[0]}" y="${ray.label[1]}" text-anchor="middle" font-size="8">${ray.dimension}</text></g>`;
  }).join('') : '';
  return `<g class="account-sun" data-mode="${mode}" transform="translate(450 ${centerY})" role="group" aria-label="${escape(account)} account sun">
<title>${escape(account)} · Account sun</title>
${rays}
<defs><radialGradient id="account-sun-glow"><stop stop-color="#fff5bb" stop-opacity=".65"/><stop offset=".5" stop-color="#ffc65c" stop-opacity=".22"/><stop offset="1" stop-color="#ff9d36" stop-opacity="0"/></radialGradient><radialGradient id="account-sun-core" cx="35%" cy="30%"><stop stop-color="#fffbe0"/><stop offset=".55" stop-color="#ffda75"/><stop offset="1" stop-color="#ee9b38"/></radialGradient><clipPath id="account-sun-clip"><circle r="${radius}"/></clipPath></defs>
<circle class="account-sun-corona" r="${radius * 2}" fill="url(#account-sun-glow)"/>
<circle class="account-sun-core" r="${radius}" fill="url(#account-sun-core)" stroke="#ffe7a0" stroke-width="1"/>
${avatar ? `<image class="account-sun-avatar" x="${-radius}" y="${-radius}" width="${radius * 2}" height="${radius * 2}" href="${avatar}" preserveAspectRatio="xMidYMid slice" clip-path="url(#account-sun-clip)"/>` : mode === 'avatar' ? `<text class="account-sun-initials" text-anchor="middle" y="${compact ? 4 : 6}" font-size="${compact ? 12 : 18}" font-weight="700" fill="#70420e">${escape(account.slice(0, 2).toUpperCase())}</text>` : ''}
<text class="account-sun-label" text-anchor="middle" y="${radius + (compact ? 11 : 15)}" font-size="${compact ? 9 : 11}" fill="var(--sky-foreground)" font-weight="600">@${escape(label)}</text></g>`;
}
