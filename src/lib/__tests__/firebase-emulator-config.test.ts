import {
  DEFAULT_FIREBASE_EMULATOR_HOSTS,
  formatEmulatorOrigin,
  formatHostPort,
  parseEmulatorHost,
} from '../firebase-emulator-config';

describe('firebase emulator config helpers', () => {
  it('parses host:port values', () => {
    expect(parseEmulatorHost('127.0.0.1:18080', DEFAULT_FIREBASE_EMULATOR_HOSTS.firestore)).toEqual({
      host: '127.0.0.1',
      port: 18080,
    });
  });

  it('parses URL values', () => {
    expect(parseEmulatorHost('http://localhost:19099', DEFAULT_FIREBASE_EMULATOR_HOSTS.auth)).toEqual({
      host: 'localhost',
      port: 19099,
    });
  });

  it('falls back on invalid values', () => {
    expect(parseEmulatorHost('not a host', DEFAULT_FIREBASE_EMULATOR_HOSTS.storage)).toEqual({
      host: '127.0.0.1',
      port: 9199,
    });
  });

  it('formats host ports and auth origins', () => {
    expect(formatHostPort({ host: 'localhost', port: 9099 })).toBe('localhost:9099');
    expect(formatEmulatorOrigin('localhost:19099', DEFAULT_FIREBASE_EMULATOR_HOSTS.auth)).toBe(
      'http://localhost:19099'
    );
  });
});
