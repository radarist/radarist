/**
 * Structured Logger
 *
 * Provides consistent, structured logging across the entire application.
 * - Server: JSON output to stdout (12-factor compliant)
 * - Client: Human-readable format to console
 * - Respects LOG_LEVEL env var (default: 'info' in prod, 'debug' in dev)
 *
 * Compatible with 'use client' components (no server-only imports).
 *
 * Usage:
 *   import { createLogger } from '@/lib/logger';
 *   const log = createLogger('my-module');
 *   log.info('Something happened', { key: 'value' });
 *   log.error('Failed to process', new Error('oops'), { id: '123' });
 */

import { redactSecrets, redactText } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): LogLevel {
  if (typeof process !== 'undefined' && process.env?.LOG_LEVEL) {
    const env = process.env.LOG_LEVEL.toLowerCase();
    if (env in LOG_LEVEL_PRIORITY) return env as LogLevel;
  }
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') {
    return 'info';
  }
  return 'debug';
}

function isServer(): boolean {
  return typeof window === 'undefined';
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    message: string;
    name: string;
    stack?: string;
  };
}

/**
 * Normalize anything caught in a `catch` block into a serializable shape.
 *
 * TypeScript's `useUnknownInCatchVariables` (and the de-facto safer pattern)
 * means `catch (err) { ... }` types `err` as `unknown`. Callers historically
 * narrow with `err instanceof Error ? err : undefined` and pass `undefined`
 * for non-Error throws — which silently drops the failure context and shows
 * up as `{}` in the console. That makes debugging impossible.
 *
 * This function accepts `unknown` and guarantees a populated entry as long
 * as something was thrown: real Errors keep `message`/`name`/`stack`;
 * strings, plain objects, and primitives become a `NonError`-named entry
 * with the stringified payload as `message`. Only `null`/`undefined` return
 * `undefined` so the caller can skip the field entirely.
 */
function serializeError(err: unknown): LogEntry['error'] {
  if (err === null || err === undefined) return undefined;
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack,
    };
  }
  if (typeof err === 'string') {
    return { message: err, name: 'NonError' };
  }
  if (typeof err === 'object') {
    // Plain object — try to JSON-stringify; if it has circular refs or
    // unserializable values, fall back to `String(err)` (commonly `[object
    // Object]` but at least non-empty).
    try {
      const json = JSON.stringify(err);
      // JSON.stringify returns `"{}"` for `{}` — preserve that signal so the
      // caller can see "an empty object was thrown" rather than confusing it
      // with "no error context at all".
      return { message: json && json !== 'null' ? json : String(err), name: 'NonError' };
    } catch {
      return { message: String(err), name: 'NonError' };
    }
  }
  // Numbers, booleans, bigints, symbols.
  return { message: String(err), name: 'NonError' };
}

/**
 * SEC-013 — mask credentials before anything reaches stdout or the browser
 * console.
 *
 * Applied centrally rather than at each call site: a log line that forgets to
 * redact is exactly how an internal MCP header, a signed URL, or an env value
 * echoed inside an error message ends up in a support bundle. `redactSecrets`
 * masks live env secret values, credential-named keys, and known credential
 * shapes; `tokenUsage`-style accounting keys are deliberately unaffected (see
 * `isSecretKeyName`).
 */
function redactEntry(entry: LogEntry): LogEntry {
  return {
    ...entry,
    message: redactText(entry.message),
    ...(entry.data ? { data: redactSecrets(entry.data) } : {}),
    ...(entry.error ? { error: redactSecrets(entry.error) } : {}),
  };
}

function emit(rawEntry: LogEntry): void {
  const minLevel = getMinLevel();
  if (LOG_LEVEL_PRIORITY[rawEntry.level] < LOG_LEVEL_PRIORITY[minLevel]) {
    return;
  }

  const entry = redactEntry(rawEntry);

  if (isServer()) {
    // Server: structured JSON to stdout
    const json = JSON.stringify(entry);
    switch (entry.level) {
      case 'debug':
        console.debug(json);
        break;
      case 'info':
        console.info(json);
        break;
      case 'warn':
        console.warn(json);
        break;
      case 'error':
        console.error(json);
        break;
    }
  } else {
    // Client: human-readable format
    const prefix = `[${entry.module}]`;
    const args: unknown[] = [prefix, entry.message];
    if (entry.data && Object.keys(entry.data).length > 0) {
      args.push(entry.data);
    }
    if (entry.error) {
      args.push(entry.error);
    }

    switch (entry.level) {
      case 'debug':
        console.debug(...args);
        break;
      case 'info':
        console.info(...args);
        break;
      case 'warn':
        console.warn(...args);
        break;
      case 'error':
        console.error(...args);
        break;
    }
  }
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  /**
   * Log an error.
   *
   * `error` accepts `unknown` so callers can pass anything caught in a
   * `catch` block directly without the `error instanceof Error ? error :
   * undefined` dance — non-Error throws (strings, objects, fetch
   * rejections, etc.) are stringified into a `NonError`-named entry rather
   * than silently dropped. See `serializeError`.
   */
  error(message: string, error?: unknown, data?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
  return {
    debug(message: string, data?: Record<string, unknown>) {
      emit({
        timestamp: new Date().toISOString(),
        level: 'debug',
        module,
        message,
        data,
      });
    },
    info(message: string, data?: Record<string, unknown>) {
      emit({
        timestamp: new Date().toISOString(),
        level: 'info',
        module,
        message,
        data,
      });
    },
    warn(message: string, data?: Record<string, unknown>) {
      emit({
        timestamp: new Date().toISOString(),
        level: 'warn',
        module,
        message,
        data,
      });
    },
    error(message: string, error?: unknown, data?: Record<string, unknown>) {
      emit({
        timestamp: new Date().toISOString(),
        level: 'error',
        module,
        message,
        data,
        error: serializeError(error),
      });
    },
  };
}

/** Default logger for quick use */
export const logger = createLogger('app');
