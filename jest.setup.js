// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// Polyfill TextEncoder/TextDecoder for Firebase SDK compatibility in Jest
import { TextEncoder, TextDecoder } from 'util';
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Polyfill Web Streams API for undici/Firebase compatibility in Jest
import { ReadableStream, TransformStream, WritableStream } from 'stream/web';
global.ReadableStream = ReadableStream;
global.TransformStream = TransformStream;
global.WritableStream = WritableStream;

// Centralized mock for fire-and-forget async patterns
// Prevents "Cannot log after tests are done" warnings from triggerEntityDocumentLinkSync
jest.mock('@/lib/inngest/functions/sync-entity-document-link-to-neo4j', () => ({
  triggerEntityDocumentLinkSync: jest.fn().mockResolvedValue(undefined),
}));

// `@/lib/inngest/send-client` is a middleware-free twin of `@/lib/inngest/client`
// that client-safe services import so Next 16 turbopack doesn't drag firebase-admin
// into client bundles (see send-client.ts). In the Node test env there's no such
// boundary, so resolve send-client to whatever `client` resolves to — mocked when a
// test does `jest.mock('@/lib/inngest/client')`, real otherwise. This keeps every
// existing client mock/assertion working without per-test changes; `.send()`
// behaviour is identical (the only difference is execution-time middleware).
jest.mock('@/lib/inngest/send-client', () => require('@/lib/inngest/client'));

// Suppress console.log and console.warn globally to reduce test noise.
// console.error is NOT suppressed — real errors remain visible.
// Tests that explicitly validate logging can restore with jest.restoreAllMocks().
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

// Close any open Neo4j driver after each test file. When Neo4j is reachable
// (local dev with the container up), tests that touch the graph open a driver
// whose live connection keeps a handle open and hangs Jest on exit (the reason
// `--forceExit` was previously needed). This runs in the test file's own module
// registry, so it closes the *actual* driver singleton; it's a no-op when the
// driver was never created or the module was mocked (e.g. CI, where Neo4j is
// unreachable). The integration runner owns this lifecycle contract.
afterAll(async () => {
  // `getGraphService()` owns a periodic health monitor in addition to the
  // Neo4j driver. Closing only the driver leaves that monitor able to fire
  // after the suite, reopen the driver, and log after Jest has completed.
  // Inspect the module cache so ordinary unit files do not initialize the
  // graph service solely for cleanup.
  try {
    const serviceFactoryPath = require.resolve('@/lib/graph/service-factory');
    const cachedServiceFactory = require.cache[serviceFactoryPath]?.exports;
    if (typeof cachedServiceFactory?.resetGraphService === 'function') {
      await cachedServiceFactory.resetGraphService();
    }
  } catch {
    // Module absent, mocked, or never loaded in this test context.
  }

  try {
    const mod = await import('@/lib/graph/neo4j-client');
    if (typeof mod.closeDriver === 'function') {
      await mod.closeDriver();
    }
  } catch {
    // Module mocked or unavailable in this test context — nothing to close.
  }
});
