// Token-free preview server for Playwright. GitHub traffic is stubbed per test
// with page.route, so the Studio always runs in public mode here.
import { createPreviewServer } from '../../scripts/preview-server.mjs';

const port = Number(process.env.E2E_PORT || 4321);
createPreviewServer().listen(port, '127.0.0.1', () => {
  console.log(`E2E preview: http://127.0.0.1:${port}`);
});
