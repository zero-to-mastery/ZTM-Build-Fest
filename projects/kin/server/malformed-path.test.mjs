// Issue #159 (A7): a static path with a malformed percent-escape is a 404,
// not a 500, and is not logged as a server error.
import assert from "node:assert/strict";
import test from "node:test";
import { createKinServer } from "./server.mjs";

test("a malformed percent-escape in a static path returns 404 and logs nothing", async (t) => {
  const application = createKinServer({ store: false, origin: "http://localhost" });
  await new Promise((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(0, "127.0.0.1", resolve);
  });
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  try {
    const url = `http://127.0.0.1:${application.server.address().port}`;
    for (const path of ["/%E0%A4%A", "/%", "/styles/%zz.css", "/%C0%80"]) {
      const response = await fetch(`${url}${path}`);
      assert.equal(response.status, 404, path);
      await response.arrayBuffer();
    }
    // Ordinary missing files and real files are unchanged.
    assert.equal((await fetch(`${url}/missing.js`)).status, 404);
    assert.equal((await fetch(`${url}/`)).status, 200);
    assert.deepEqual(errors, [], "no request_failed log");
  } finally {
    await new Promise((resolve) => application.server.close(resolve));
  }
});
