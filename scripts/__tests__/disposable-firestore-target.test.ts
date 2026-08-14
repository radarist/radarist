/**
 * @file disposable-firestore-target.test.ts
 * @description Locks the fail-closed contract for destructive Firestore resets
 * (GRAPH-038). A real project id, or an explicit non-loopback emulator host,
 * must reject; only a disposable `demo-*` project on a loopback (or unset)
 * emulator host is allowed.
 */

import { isLoopbackHost, assertDisposableFirestoreResetTarget } from '../lib/disposable-firestore-target';

describe('isLoopbackHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.1:8080', true],
    ['localhost', true],
    ['localhost:8080', true],
    ['::1', true],
    ['[::1]:8080', true],
    ['http://127.0.0.1:8080', true],
    ['10.0.0.5:8080', false],
    ['192.168.1.10', false],
    ['firestore.googleapis.com', false],
    ['firestore.example.com:8080', false],
  ])('classifies %s as loopback=%s', (value, expected) => {
    expect(isLoopbackHost(value)).toBe(expected);
  });
});

describe('assertDisposableFirestoreResetTarget', () => {
  it('accepts a demo-* project with a loopback emulator host', () => {
    const target = assertDisposableFirestoreResetTarget('demo-radarist', {
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    } as NodeJS.ProcessEnv);
    expect(target).toEqual({ projectId: 'demo-radarist', emulatorHost: '127.0.0.1:8080' });
  });

  it('accepts a demo-* project with an unset host (loopback default + pinned routing)', () => {
    const target = assertDisposableFirestoreResetTarget('demo-radarist-selftest', {} as NodeJS.ProcessEnv);
    expect(target).toEqual({ projectId: 'demo-radarist-selftest', emulatorHost: null });
  });

  it('accepts a demo-* project with a localhost host', () => {
    expect(
      assertDisposableFirestoreResetTarget('demo-test', {
        FIRESTORE_EMULATOR_HOST: 'localhost:8080',
      } as NodeJS.ProcessEnv)
    ).toEqual({ projectId: 'demo-test', emulatorHost: 'localhost:8080' });
  });

  it('REJECTS a real production project id even on a loopback host', () => {
    expect(() =>
      assertDisposableFirestoreResetTarget('radarist-glyyr', {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      } as NodeJS.ProcessEnv)
    ).toThrow(/disposable demo-\* Firebase project/);
  });

  it('REJECTS an unset / empty project id', () => {
    expect(() => assertDisposableFirestoreResetTarget('', {} as NodeJS.ProcessEnv)).toThrow(
      /disposable demo-\* Firebase project/
    );
  });

  it('REJECTS a demo-* project when the explicit host is NOT loopback', () => {
    expect(() =>
      assertDisposableFirestoreResetTarget('demo-radarist', {
        FIRESTORE_EMULATOR_HOST: '10.0.0.5:8080',
      } as NodeJS.ProcessEnv)
    ).toThrow(/FIRESTORE_EMULATOR_HOST must be a loopback emulator/);
  });

  it('REJECTS a remote emulator host regardless of the demo project', () => {
    expect(() =>
      assertDisposableFirestoreResetTarget('demo-radarist', {
        FIRESTORE_EMULATOR_HOST: 'firestore.staging.internal:8080',
      } as NodeJS.ProcessEnv)
    ).toThrow(/loopback emulator/);
  });
});
