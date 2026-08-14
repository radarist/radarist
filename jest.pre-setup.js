/**
 * jest.pre-setup.js — runs via setupFiles (before JSDOM initializes).
 *
 * JSDOM does not expose the Web fetch API constructors (Response, Request,
 * Headers). Node 18+ has them on globalThis natively, but JSDOM's environment
 * setup overwrites global before setupFilesAfterEnv runs. By capturing here —
 * before JSDOM — we preserve them for tests that construct Response objects
 * directly (e.g. scout-url-verifier.test.ts).
 */

// Store native Node fetch globals before JSDOM can shadow them.
// In Node 18+ these exist on globalThis. If already defined (e.g. running in
// a non-JSDOM environment), the guard is a no-op.
const _nativeResponse = globalThis.Response;
const _nativeRequest = globalThis.Request;
const _nativeHeaders = globalThis.Headers;

// Re-apply after each potential JSDOM override via Object.defineProperty so
// tests can use `new Response(...)` without import.
if (_nativeResponse) {
  Object.defineProperty(global, 'Response', {
    configurable: true,
    writable: true,
    value: _nativeResponse,
  });
}
if (_nativeRequest) {
  Object.defineProperty(global, 'Request', {
    configurable: true,
    writable: true,
    value: _nativeRequest,
  });
}
if (_nativeHeaders) {
  Object.defineProperty(global, 'Headers', {
    configurable: true,
    writable: true,
    value: _nativeHeaders,
  });
}

// ── Real-Neo4j integration suites ──
// Jest under NODE_ENV=test does not load .env.local. The guarded integration
// runner supplies and validates NEO4J_URI before enabling these suites; this
// setup revalidates the target so direct Jest invocations cannot bypass the
// guard, then hydrates only missing credentials/database values.
if (process.env.NEO4J_INTEGRATION_TESTS === '1') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assertDisposableNeo4jIntegrationTarget } = require('./scripts/testing/neo4j-integration-target.cjs');
  assertDisposableNeo4jIntegrationTarget(process.env);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv');
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env.local');
  if (fs.existsSync(envPath)) {
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    for (const key of ['NEO4J_USER', 'NEO4J_USERNAME', 'NEO4J_PASSWORD', 'NEO4J_DATABASE']) {
      if (parsed[key] && !process.env[key]) process.env[key] = parsed[key];
    }
  }
}
