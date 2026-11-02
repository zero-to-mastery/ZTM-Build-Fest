import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from './preview-server.mjs';

try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.gh_token;
createPreviewServer({ token }).listen(Number(process.env.PORT || 4173), '127.0.0.1', function () {
  console.log(`Preview: http://127.0.0.1:${this.address().port}`);
  console.log(`GitHub requests: ${token ? 'authenticated with local token' : 'public (no local token found)'}`);
});
