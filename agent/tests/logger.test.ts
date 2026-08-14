import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger, createLogger } from '../src/logger.js';

describe('Logger', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write to log file with timestamp and level', () => {
    const logFile = path.join(tmpDir, 'test.log');
    const logger = new Logger({ logFile, console: false });

    logger.info('hello world');
    logger.warn('a warning');
    logger.error('an error');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*INFO\s+hello world$/);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*WARN\s+a warning$/);
    expect(lines[2]).toMatch(/^\d{4}-\d{2}-\d{2}T.*ERROR\s+an error$/);
  });

  it('should respect minimum log level', () => {
    const logFile = path.join(tmpDir, 'level.log');
    const logger = new Logger({ logFile, console: false, level: 'warn' });

    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('visible');
    logger.error('visible');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('visible');
    expect(lines[1]).toContain('visible');
  });

  it('should create log directory if it does not exist', () => {
    const logFile = path.join(tmpDir, 'nested', 'deep', 'test.log');
    const logger = new Logger({ logFile, console: false });

    logger.info('nested works');
    logger.close();

    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('nested works');
  });

  it('should append to existing log file', () => {
    const logFile = path.join(tmpDir, 'append.log');
    fs.writeFileSync(logFile, 'existing line\n');

    const logger = new Logger({ logFile, console: false });
    logger.info('new line');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('existing line');
    expect(content).toContain('new line');
  });

  it('log() should alias info()', () => {
    const logFile = path.join(tmpDir, 'alias.log');
    const logger = new Logger({ logFile, console: false });

    logger.log('via log method');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('INFO');
    expect(content).toContain('via log method');
  });
});

describe('createLogger', () => {
  const originalEnv = process.env['IMPULSE_LOG_FILE'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['IMPULSE_LOG_FILE'] = originalEnv;
    } else {
      delete process.env['IMPULSE_LOG_FILE'];
    }
  });

  it('should use explicit logFile argument', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-create-'));
    const logFile = path.join(tmpDir, 'explicit.log');

    const logger = createLogger(logFile);
    logger.info('explicit test');
    logger.close();

    expect(fs.existsSync(logFile)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should use IMPULSE_LOG_FILE env var when no argument', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-env-'));
    const logFile = path.join(tmpDir, 'env.log');
    process.env['IMPULSE_LOG_FILE'] = logFile;

    const logger = createLogger();
    logger.info('env test');
    logger.close();

    expect(fs.existsSync(logFile)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should disable file logging when set to "none"', () => {
    process.env['IMPULSE_LOG_FILE'] = 'none';

    const logger = createLogger();
    // Should not throw - just writes to console
    logger.info('console only');
    logger.close();
  });
});
