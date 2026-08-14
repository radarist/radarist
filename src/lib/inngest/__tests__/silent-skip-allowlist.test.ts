/**
 * @jest-environment node
 *
 * P3-B silent-skip gate (graph-foundation master plan, graph:health v2a).
 *
 * An Inngest handler returning `{ skipped: true }` is invisible to operators:
 * the run reports success while doing no work. This static gate makes that a
 * CI failure unless the skip carries an allowlisted reason constant from
 * `src/lib/inngest/skip-reasons.ts` — adding a new silent-skip path requires
 * deliberately adding (and thereby documenting) a new SKIP_REASONS entry.
 *
 * Static source check (not runtime) so it runs offline in CI without Inngest,
 * Firestore, or Neo4j.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { SKIP_REASONS } from '../skip-reasons';

const FUNCTIONS_DIR = join(__dirname, '..', 'functions');

/** Window (chars) around a `skipped: true` match that must name the reason constant. */
const CONTEXT_WINDOW = 300;

function listFunctionFiles(): string[] {
  return readdirSync(FUNCTIONS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(FUNCTIONS_DIR, f));
}

describe('silent-skip allowlist gate (P3-B)', () => {
  it('finds handler files to scan (guards against a moved directory silently passing)', () => {
    expect(listFunctionFiles().length).toBeGreaterThan(20);
  });

  it('every `skipped: true` return carries an allowlisted SKIP_REASONS constant', () => {
    const offenders: string[] = [];

    for (const file of listFunctionFiles()) {
      const source = readFileSync(file, 'utf8');
      const pattern = /skipped:\s*true/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        const start = Math.max(0, match.index - CONTEXT_WINDOW);
        const end = Math.min(source.length, match.index + CONTEXT_WINDOW);
        const window = source.slice(start, end);
        if (!window.includes('SKIP_REASONS.')) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${file.split('/functions/')[1]}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('SKIP_REASONS values are unique, non-empty strings', () => {
    const values = Object.values(SKIP_REASONS);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it('every SKIP_REASONS constant is referenced by at least one handler (no dead allowlist entries)', () => {
    const sources = listFunctionFiles().map((f) => readFileSync(f, 'utf8'));
    const unreferenced = Object.keys(SKIP_REASONS).filter(
      (key) => !sources.some((s) => s.includes(`SKIP_REASONS.${key}`))
    );
    expect(unreferenced).toEqual([]);
  });
});
