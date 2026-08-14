/**
 * Tests for lib/logger.ts
 *
 * Note: Jest uses jsdom environment so `typeof window !== 'undefined'` is always true.
 * Tests verify client-side (human-readable) output format. Server-side JSON output
 * is structurally identical but serialized — covered implicitly via the same emit path.
 */

// Save original env
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  process.env = { ...originalEnv };
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = originalEnv;
});

// Must use require to get fresh module for each env config change
function freshLogger() {
  jest.resetModules();
  return require('../logger');
}

describe('logger', () => {
  // ==========================================================================
  // createLogger basic functionality
  // ==========================================================================

  describe('createLogger', () => {
    it('should create a logger with all log methods', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('test-module');

      expect(typeof log.debug).toBe('function');
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.error).toBe('function');
    });

    it('should export a default logger instance', () => {
      const { logger } = freshLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });
  });

  // ==========================================================================
  // Output format (client-side in jsdom)
  // ==========================================================================

  describe('output format', () => {
    it('should output with module prefix for info', () => {
      process.env.LOG_LEVEL = 'debug';
      const { createLogger } = freshLogger();
      const log = createLogger('api');

      log.info('Request received', { path: '/api/test' });

      expect(console.info).toHaveBeenCalledTimes(1);
      const args = (console.info as jest.Mock).mock.calls[0];
      expect(args[0]).toBe('[api]');
      expect(args[1]).toBe('Request received');
      expect(args[2]).toEqual({ path: '/api/test' });
    });

    it('should call console.debug for debug level', () => {
      process.env.LOG_LEVEL = 'debug';
      const { createLogger } = freshLogger();
      const log = createLogger('db');

      log.debug('Query executed', { query: 'SELECT 1' });

      expect(console.debug).toHaveBeenCalledTimes(1);
      const args = (console.debug as jest.Mock).mock.calls[0];
      expect(args[0]).toBe('[db]');
      expect(args[1]).toBe('Query executed');
    });

    it('should call console.warn for warn level', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('cache');

      log.warn('Cache miss', { key: 'user:123' });

      expect(console.warn).toHaveBeenCalledTimes(1);
      const args = (console.warn as jest.Mock).mock.calls[0];
      expect(args[0]).toBe('[cache]');
    });

    it('should call console.error for error level', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('service');

      log.error('Database error');

      expect(console.error).toHaveBeenCalledTimes(1);
      const args = (console.error as jest.Mock).mock.calls[0];
      expect(args[0]).toBe('[service]');
      expect(args[1]).toBe('Database error');
    });

    it('should not include empty data in output', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('ui');

      log.warn('Deprecation notice');

      const args = (console.warn as jest.Mock).mock.calls[0];
      expect(args).toHaveLength(2); // prefix + message only
    });

    it('should include error object in output', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('service');
      const err = new Error('Connection failed');

      log.error('DB error', err, { host: 'localhost' });

      const args = (console.error as jest.Mock).mock.calls[0];
      expect(args[0]).toBe('[service]');
      expect(args[1]).toBe('DB error');
      expect(args[2]).toEqual({ host: 'localhost' });
      expect(args[3]).toMatchObject({
        message: 'Connection failed',
        name: 'Error',
      });
    });

    it('should handle error call without Error object', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('service');

      log.error('Something went wrong');

      const args = (console.error as jest.Mock).mock.calls[0];
      expect(args).toHaveLength(2); // prefix + message, no error
    });
  });

  // ==========================================================================
  // Level filtering
  // ==========================================================================

  describe('level filtering', () => {
    it('should respect LOG_LEVEL=warn (suppress debug and info)', () => {
      process.env.LOG_LEVEL = 'warn';
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.debug('debug msg');
      log.info('info msg');
      log.warn('warn msg');
      log.error('error msg');

      expect(console.debug).not.toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('should respect LOG_LEVEL=error (suppress all but error)', () => {
      process.env.LOG_LEVEL = 'error';
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.debug('debug msg');
      log.info('info msg');
      log.warn('warn msg');
      log.error('error msg');

      expect(console.debug).not.toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('should respect LOG_LEVEL=info (suppress debug only)', () => {
      process.env.LOG_LEVEL = 'info';
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.debug('debug msg');
      log.info('info msg');

      expect(console.debug).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledTimes(1);
    });

    it('should default to debug in non-production', () => {
      delete process.env.LOG_LEVEL;
      (process.env as Record<string, string>).NODE_ENV = 'development';
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.debug('debug msg');
      expect(console.debug).toHaveBeenCalledTimes(1);
    });

    it('should default to info in production', () => {
      delete process.env.LOG_LEVEL;
      (process.env as Record<string, string>).NODE_ENV = 'production';
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.debug('should be suppressed');
      log.info('should appear');

      expect(console.debug).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledTimes(1);
    });

    it('should ignore invalid LOG_LEVEL values', () => {
      process.env.LOG_LEVEL = 'invalid';
      (process.env as Record<string, string>).NODE_ENV = 'test';
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      // Should fall back to debug (non-production)
      log.debug('debug msg');
      expect(console.debug).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Error serialization
  // ==========================================================================

  describe('error serialization', () => {
    it('should serialize custom Error subclasses', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }

      log.error('Custom failure', new CustomError('bad input'));

      const args = (console.error as jest.Mock).mock.calls[0];
      const errorArg = args[args.length - 1];
      expect(errorArg.name).toBe('CustomError');
      expect(errorArg.message).toBe('bad input');
      expect(errorArg.stack).toBeDefined();
    });

    it('should include both data and error when both provided', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.error('Failed', new Error('oops'), { retryCount: 3 });

      const args = (console.error as jest.Mock).mock.calls[0];
      expect(args[0]).toBe('[test]');
      expect(args[1]).toBe('Failed');
      expect(args[2]).toEqual({ retryCount: 3 });
      expect(args[3].message).toBe('oops');
    });

    // ========================================================================
    // Non-Error throws — the regression these tests exist to catch
    // ========================================================================
    //
    // Before 2026-05-08, the Logger.error contract was `error?: Error` so
    // callers used `error instanceof Error ? error : undefined` to narrow
    // — and silently dropped non-Error throws on the floor. The browser
    // console then showed `{}` which made debugging impossible. The new
    // contract is `error?: unknown` and serializeError handles strings,
    // plain objects, and primitives explicitly.

    it('should serialize a thrown string as a NonError entry', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.error('Failed', 'something went sideways');

      const args = (console.error as jest.Mock).mock.calls[0];
      const errorArg = args[args.length - 1];
      expect(errorArg.name).toBe('NonError');
      expect(errorArg.message).toBe('something went sideways');
    });

    it('should serialize a thrown plain object as JSON', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.error('Failed', { code: 'NETWORK_ERROR', status: 500 });

      const args = (console.error as jest.Mock).mock.calls[0];
      const errorArg = args[args.length - 1];
      expect(errorArg.name).toBe('NonError');
      expect(errorArg.message).toBe('{"code":"NETWORK_ERROR","status":500}');
    });

    it('should serialize an empty thrown object explicitly (not as undefined)', () => {
      // Catch with an empty object literal is the case that produced the
      // user-visible `{}` in the browser console. The new contract should
      // surface it as a NonError with `message: "{}"` so the reader sees
      // "an empty object was thrown" instead of nothing.
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.error('Failed', {});

      const args = (console.error as jest.Mock).mock.calls[0];
      const errorArg = args[args.length - 1];
      expect(errorArg.name).toBe('NonError');
      expect(errorArg.message).toBe('{}');
    });

    it('should serialize a number as a NonError entry', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.error('Failed', 42);

      const args = (console.error as jest.Mock).mock.calls[0];
      const errorArg = args[args.length - 1];
      expect(errorArg.name).toBe('NonError');
      expect(errorArg.message).toBe('42');
    });

    it('should omit error field when error is null or undefined', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      log.error('No error attached', undefined, { context: 'noop' });

      const args = (console.error as jest.Mock).mock.calls[0];
      // With `data` present but `error` undefined, the args should be
      // [prefix, message, data] — no fourth slot.
      expect(args).toHaveLength(3);
      expect(args[2]).toEqual({ context: 'noop' });
    });

    it('should handle objects with circular references without throwing', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('test');

      // Build a circular object — JSON.stringify would normally throw on this.
      const circular: Record<string, unknown> = { name: 'loop' };
      circular.self = circular;

      // The logger must not throw when given a circular ref; it should fall
      // back to String(err) and emit something rather than crashing.
      expect(() => log.error('Circular', circular)).not.toThrow();

      const args = (console.error as jest.Mock).mock.calls[0];
      const errorArg = args[args.length - 1];
      expect(errorArg.name).toBe('NonError');
      expect(typeof errorArg.message).toBe('string');
      expect(errorArg.message.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Module prefix
  // ==========================================================================

  describe('module prefix', () => {
    it('should include module name in output', () => {
      const { createLogger } = freshLogger();
      const log = createLogger('neo4j-client');

      log.info('Connected');

      const args = (console.info as jest.Mock).mock.calls[0];
      expect(args[0]).toBe('[neo4j-client]');
    });

    it('should use "app" module for default logger', () => {
      const { logger } = freshLogger();

      logger.info('Hello');

      const args = (console.info as jest.Mock).mock.calls[0];
      expect(args[0]).toBe('[app]');
    });
  });
});
