/**
 * Unit tests for AuditRecorder (TEST-011).
 *
 * The load-bearing property: structured step evidence survives an interrupt that
 * happens BEFORE `stop()` — because every step transition is atomically
 * checkpointed. Plus: screenshots are bounded, cleanup is exact-owned, and an
 * unsafe run id is rejected before it can escape the audit root.
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditRecorder, readAuditCheckpoint, assertSafeRunId } from '../audit-recorder';

let root: string;
let clock: number;
const tick = () => (clock += 1);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'audit-rec-'));
  clock = 1000;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRecorder(runId = 'run-1', opts = {}) {
  return new AuditRecorder({ runId, outputRoot: root, now: tick, ...opts });
}

describe('AuditRecorder — atomic evidence checkpointing', () => {
  it('retains completed steps AND the active step when interrupted before stop()', () => {
    const rec = makeRecorder();
    rec.startStep('open entity');
    rec.passStep();
    rec.startStep('edit field');
    rec.passStep();
    rec.startStep('save'); // still active — simulate a hang/interrupt here

    // No stop() is ever called. Read the on-disk checkpoint directly.
    const cp = readAuditCheckpoint(rec.dir);
    expect(cp.steps.map((s) => [s.name, s.status])).toEqual([
      ['open entity', 'passed'],
      ['edit field', 'passed'],
      ['save', 'active'],
    ]);
    expect(cp.finished).toBe(false);
  });

  it('writes a valid checkpoint after every transition (never a half-written file)', () => {
    const rec = makeRecorder();
    rec.startStep('a');
    // Each read parses cleanly (atomic rename guarantees no partial JSON).
    expect(() => readAuditCheckpoint(rec.dir)).not.toThrow();
    rec.failStep(new Error('boom'));
    const cp = readAuditCheckpoint(rec.dir);
    expect(cp.steps[0]).toMatchObject({ name: 'a', status: 'failed', error: 'boom' });
  });

  it('stop() fails an interrupted active step and marks the run finished', () => {
    const rec = makeRecorder();
    rec.startStep('hanging');
    const cp = rec.stop();
    expect(cp.finished).toBe(true);
    expect(cp.finishedAt).toBeGreaterThan(cp.startedAt);
    expect(cp.steps[0]).toMatchObject({ status: 'failed' });
    expect(cp.steps[0].error).toMatch(/interrupted/);
  });

  it('auto-fails a prior active step when a new step starts', () => {
    const rec = makeRecorder();
    rec.startStep('first');
    rec.startStep('second'); // 'first' was never ended
    const cp = readAuditCheckpoint(rec.dir);
    expect(cp.steps[0]).toMatchObject({ status: 'failed' });
    expect(cp.steps[0].error).toMatch(/abandoned/);
    expect(cp.steps[1]).toMatchObject({ name: 'second', status: 'active' });
  });
});

describe('AuditRecorder — bounded screenshots', () => {
  it('retains at most maxScreenshots and counts the drops (no silent loss)', () => {
    const rec = makeRecorder('run-shots', { maxScreenshots: 3 });
    rec.startStep('failing');
    const results = Array.from({ length: 5 }, (_, i) => rec.attachScreenshot(Buffer.from(`png-${i}`), `s${i}`));
    expect(results.filter((r) => r !== null)).toHaveLength(3);
    expect(results.filter((r) => r === null)).toHaveLength(2);

    const cp = readAuditCheckpoint(rec.dir);
    expect(cp.screenshotsRetained).toBe(3);
    expect(cp.screenshotsDropped).toBe(2);
    expect(readdirSync(join(rec.dir, 'screenshots'))).toHaveLength(3);
  });

  it('drops an oversized screenshot instead of writing it', () => {
    const rec = makeRecorder('run-big', { maxScreenshotBytes: 8 });
    rec.startStep('failing');
    expect(rec.attachScreenshot(Buffer.alloc(9), 'too-big')).toBeNull();
    expect(rec.attachScreenshot(Buffer.alloc(4), 'ok')).not.toBeNull();
    const cp = readAuditCheckpoint(rec.dir);
    expect(cp.screenshotsRetained).toBe(1);
    expect(cp.screenshotsDropped).toBe(1);
  });
});

describe('AuditRecorder — exact-owned cleanup', () => {
  it('removes only its own run directory, never a sibling run', () => {
    const sibling = join(root, 'other-run');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'keep.txt'), 'primary data');

    const rec = makeRecorder('run-cleanup');
    rec.startStep('x');
    rec.stop();
    expect(existsSync(rec.dir)).toBe(true);

    rec.cleanup();
    expect(existsSync(rec.dir)).toBe(false); // own dir gone
    expect(existsSync(join(sibling, 'keep.txt'))).toBe(true); // sibling untouched
  });
});

describe('AuditRecorder — run-id safety (cannot escape the audit root)', () => {
  it.each([
    ['..', '..'],
    ['traversal', '../evil'],
    ['nested', 'a/b'],
    ['absolute-posix', '/etc/passwd'],
    ['backslash', 'a\\b'],
    ['dot', '.'],
    ['empty', ''],
    ['nul', 'a\0b'],
  ])('rejects an unsafe runId (%s)', (_label, bad) => {
    expect(() => assertSafeRunId(bad)).toThrow();
    expect(() => new AuditRecorder({ runId: bad, outputRoot: root })).toThrow();
  });

  it('accepts a normal dated run id', () => {
    expect(() => assertSafeRunId('2026-07-15-entity-lane')).not.toThrow();
  });
});
