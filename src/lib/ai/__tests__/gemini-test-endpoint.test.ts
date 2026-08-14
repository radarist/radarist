/**
 * @file gemini-test-endpoint.test.ts
 * @description TEST-017/AI-020 — guard contract for the deterministic Gemini
 * provider seam. The override may activate ONLY when every independent guard
 * holds: explicit opt-in env, loopback URL, emulator-wired Firestore, and a
 * disposable `demo-*` Firebase project. Anything else resolves to undefined
 * (the SDK then uses its normal Google endpoint) — fail-closed, never throw.
 */

import { resolveGeminiTestRequestOptions } from '../gemini-test-endpoint';

/** A fully-guarded environment the override is ALLOWED to activate in. */
function disposableEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    GEMINI_TEST_BASE_URL: 'http://127.0.0.1:18790',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('resolveGeminiTestRequestOptions', () => {
  it('returns the loopback baseUrl when every guard holds', () => {
    expect(resolveGeminiTestRequestOptions(disposableEnv())).toEqual({
      baseUrl: 'http://127.0.0.1:18790',
    });
  });

  it('accepts localhost and IPv6 loopback hostnames', () => {
    expect(resolveGeminiTestRequestOptions(disposableEnv({ GEMINI_TEST_BASE_URL: 'http://localhost:18790' }))).toEqual({
      baseUrl: 'http://localhost:18790',
    });
    expect(resolveGeminiTestRequestOptions(disposableEnv({ GEMINI_TEST_BASE_URL: 'http://[::1]:18790' }))).toEqual({
      baseUrl: 'http://[::1]:18790',
    });
  });

  it('is inert when the opt-in env is absent or blank', () => {
    expect(resolveGeminiTestRequestOptions(disposableEnv({ GEMINI_TEST_BASE_URL: undefined }))).toBeUndefined();
    expect(resolveGeminiTestRequestOptions(disposableEnv({ GEMINI_TEST_BASE_URL: '   ' }))).toBeUndefined();
    expect(resolveGeminiTestRequestOptions({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('refuses every non-loopback host — the exfiltration vector', () => {
    for (const url of [
      'https://attacker.example.com',
      'http://10.0.0.8:18790',
      'http://192.168.1.20:18790',
      'http://127.0.0.1.evil.example:18790',
      'http://localhost.evil.example:18790',
      'http://generativelanguage.googleapis.com',
    ]) {
      expect(resolveGeminiTestRequestOptions(disposableEnv({ GEMINI_TEST_BASE_URL: url }))).toBeUndefined();
    }
  });

  it('refuses non-HTTP schemes and unparseable URLs', () => {
    for (const url of ['file:///etc/passwd', 'ftp://127.0.0.1/x', 'not a url', '//127.0.0.1:18790']) {
      expect(resolveGeminiTestRequestOptions(disposableEnv({ GEMINI_TEST_BASE_URL: url }))).toBeUndefined();
    }
  });

  it('refuses when Firestore is not emulator-wired (production stores)', () => {
    expect(resolveGeminiTestRequestOptions(disposableEnv({ FIRESTORE_EMULATOR_HOST: undefined }))).toBeUndefined();
    expect(resolveGeminiTestRequestOptions(disposableEnv({ FIRESTORE_EMULATOR_HOST: '' }))).toBeUndefined();
  });

  it('refuses when the Firebase project is not a disposable demo-* project', () => {
    expect(
      resolveGeminiTestRequestOptions(disposableEnv({ NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'radarist-prod' }))
    ).toBeUndefined();
    expect(
      resolveGeminiTestRequestOptions(disposableEnv({ NEXT_PUBLIC_FIREBASE_PROJECT_ID: undefined }))
    ).toBeUndefined();
  });

  it('screens every configured project id source, not just the first', () => {
    // A real project id in ANY slot must veto activation even when another
    // slot names a demo project — split-brain env is not a disposable target.
    expect(
      resolveGeminiTestRequestOptions(
        disposableEnv({ FIREBASE_PROJECT_ID: 'radarist-prod', GCLOUD_PROJECT: 'demo-radarist' })
      )
    ).toBeUndefined();
    expect(
      resolveGeminiTestRequestOptions(
        disposableEnv({
          FIREBASE_PROJECT_ID: 'demo-radarist',
          GCLOUD_PROJECT: 'demo-radarist',
          GOOGLE_CLOUD_PROJECT: 'demo-radarist',
        })
      )
    ).toEqual({ baseUrl: 'http://127.0.0.1:18790' });
  });

  it('never throws on malformed environments', () => {
    expect(() =>
      resolveGeminiTestRequestOptions(
        disposableEnv({ GEMINI_TEST_BASE_URL: 'http://%%%', NEXT_PUBLIC_FIREBASE_PROJECT_ID: undefined })
      )
    ).not.toThrow();
  });
});
