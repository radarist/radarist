/**
 * jest.environment.js — Custom Jest environment extending JSDOM.
 *
 * Restores Web fetch API constructors (Response, Request, Headers) that Node
 * 18+ provides natively but JSDOM does not include. Tests that construct
 * `new Response(...)` directly (e.g. scout-url-verifier.test.ts) need these.
 *
 * Node's native fetch globals live on the Node process globalThis — they are
 * NOT accessible inside the JSDOM VM sandbox. This environment bridges them
 * by injecting them into the JSDOM global before any test code runs.
 */

const JSDOMEnvironment = require('jest-environment-jsdom').default;

// Capture Node's native fetch API constructors before the JSDOM sandbox
// is created (these exist on the Node process globalThis in Node 18+).
const _NativeResponse = globalThis.Response;
const _NativeRequest = globalThis.Request;
const _NativeHeaders = globalThis.Headers;
const _NativeCrypto = globalThis.crypto;

class FetchAwareJSDOMEnvironment extends JSDOMEnvironment {
  async setup() {
    await super.setup();
    // Inject native fetch constructors into the JSDOM global if missing.
    if (_NativeResponse && !this.global.Response) {
      this.global.Response = _NativeResponse;
    }
    if (_NativeRequest && !this.global.Request) {
      this.global.Request = _NativeRequest;
    }
    if (_NativeHeaders && !this.global.Headers) {
      this.global.Headers = _NativeHeaders;
    }

    // JSDOM implements crypto.getRandomValues but omits the SubtleCrypto
    // interface that every real browser exposes. Modules hashing with WebCrypto
    // (entity/relation source fingerprints) would otherwise be unreachable from
    // the default environment, forcing per-suite Node-environment
    // opt-outs that also discard the DOM those suites legitimately use.
    if (_NativeCrypto?.subtle) {
      if (!this.global.crypto) {
        this.global.crypto = _NativeCrypto;
      } else if (!this.global.crypto.subtle) {
        Object.defineProperty(this.global.crypto, 'subtle', {
          value: _NativeCrypto.subtle,
          configurable: true,
        });
      }
    }
  }
}

module.exports = FetchAwareJSDOMEnvironment;
