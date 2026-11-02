// Netlify Function wrapper around the portable sign-in exchange. GitHub Pages
// serves the Studio; this function only trades an authorization code (with
// its PKCE verifier) for a user access token, keeping the client secret
// server-side. See docs/github-oauth.md.
import { exchange } from '../../github-exchange.mjs';

// Read at request time: Netlify injects these from the site's environment
// variables (not netlify.toml, which functions can't see).
const environment = () => ({
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  GITHUB_REDIRECT_URI: process.env.GITHUB_REDIRECT_URI,
  STUDIO_ORIGIN: process.env.STUDIO_ORIGIN,
});

export default (request) => exchange(request, environment());

export const config = {
  path: '/api/github-exchange',
  // A sign-in needs one or two calls; 20 a minute per visitor stops abuse
  // without ever getting in a person's way. Available on every Netlify plan.
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
