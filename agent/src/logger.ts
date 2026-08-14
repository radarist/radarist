import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { redactText } from './redaction.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  /** Path to log file. If not set, logs go to stdout only. */
  logFile?: string;
  /** Minimum level to log. Defaults to 'info'. */
  level?: LogLevel;
  /** Also write to stdout/stderr. Defaults to true. */
  console?: boolean;
}

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  private readonly fd: number | undefined;
  private readonly minLevel: number;
  private readonly useConsole: boolean;

  constructor(options?: LoggerOptions) {
    this.minLevel = LEVEL_ORDER[options?.level ?? 'info'];
    this.useConsole = options?.console ?? true;

    if (options?.logFile) {
      // Ensure directory exists
      const dir = path.dirname(options.logFile);
      fs.mkdirSync(dir, { recursive: true });
      // Open file in append mode
      this.fd = fs.openSync(options.logFile, 'a');
    }
  }

  private write(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const timestamp = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    // SEC-013: redact at the single point where a line becomes bytes. This file
    // is `logs/agent.log`, which support bundles and release evidence collect,
    // so a caller that forgets to redact must not be able to reintroduce the
    // leak. Callers that already redact are unaffected — the pass is idempotent.
    const line = `${timestamp} ${tag} ${redactText(message)}\n`;

    if (this.fd !== undefined) {
      fs.writeSync(this.fd, line);
    }

    if (this.useConsole) {
      if (level === 'error') {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    }
  }

  debug(message: string): void {
    this.write('debug', message);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  /** Convenience: replace console.log calls. */
  log(message: string): void {
    this.info(message);
  }

  /** Flush and close the log file. */
  close(): void {
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
    }
  }
}

// ---------------------------------------------------------------------------
// Default instance
// ---------------------------------------------------------------------------

/**
 * Default log directory: <project-root>/logs/
 *
 * We resolve relative to this file's location so it works whether called
 * from the CLI (`agent/dist/`) or dynamically imported by Inngest.
 */
function resolveDefaultLogFile(): string {
  // agent/src/logger.ts → agent/ → project root
  const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const projectRoot = path.resolve(agentDir, '..');
  return path.join(projectRoot, 'logs', 'agent.log');
}

/**
 * Create a logger from CLI flags / env vars.
 *
 * Resolution order:
 * 1. Explicit `logFile` argument
 * 2. `IMPULSE_LOG_FILE` env var
 * 3. `<project-root>/logs/agent.log`
 *
 * Set `IMPULSE_LOG_FILE=none` to disable file logging.
 */
export function createLogger(logFile?: string): Logger {
  const resolved = logFile ?? process.env['IMPULSE_LOG_FILE'] ?? resolveDefaultLogFile();

  if (resolved === 'none') {
    return new Logger({ console: true });
  }

  return new Logger({ logFile: resolved, console: true });
}
