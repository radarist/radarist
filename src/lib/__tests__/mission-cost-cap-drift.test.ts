/**
 * @file mission-cost-cap-drift.test.ts
 * @description AUDIT-003 — the mission cost cap must have one value, not four.
 *
 * The repo shipped three different numbers across five locations: the code
 * enforced $15, while `.env.example`, the public overview, the mission-lifecycle
 * doc and RESPONSIBLE-AI all promised $5. Which one you got depended on how you
 * onboarded — `npm run setup:local` never writes MISSION_MAX_COST_USD, so a
 * fresh clone runs on the code default ($15), while anyone who hand-copied
 * `.env.example` silently ran on a 3×-tighter cap.
 *
 * Prose is re-driftable and this exact correction had already drifted back
 * once. A test is the only thing that holds.
 *
 * Deliberately scoped to the COST variable. The neighbouring
 * `MISSION_TIMEOUT_MINUTES` already violates the same invariant (`.env.example`
 * says 30, the mission runtime defaults to 45), so a generalized
 * "every MISSION_* in .env.example equals its code default" rule would fail on
 * day one. That is a real, separate drift — recorded here, not silently swept
 * into this test's scope.
 */

import fs from 'fs';
import path from 'path';
import { DEFAULT_MISSION_LIMITS } from '../mission-limits';

/** Read a `KEY=value` assignment out of .env.example. */
function readEnvExample(key: string): string | null {
  const file = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
  const match = file.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

describe('mission cost cap — single source of truth (AUDIT-003)', () => {
  it('.env.example ships the same cap the code defaults to', () => {
    const shipped = readEnvExample('MISSION_MAX_COST_USD');

    expect(shipped).not.toBeNull();
    expect(Number(shipped)).toBe(DEFAULT_MISSION_LIMITS.maxCostUsd);
  });

  it('the revision-pass cap stays at the 80% its own comment claims', () => {
    // REVISION_MAX_COST_USD is a SEPARATE, ADDITIVE budget on top of the mission
    // cap, so a stale value here is real money: at 80% of $15 the worst case for
    // a mission plus its revision pass is ~$27, not ~$15.
    const file = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
    const revision = file.match(/^#\s*REVISION_MAX_COST_USD=(.+)$/m)?.[1].trim() ?? null;

    expect(revision).not.toBeNull();
    expect(Number(revision)).toBeCloseTo(DEFAULT_MISSION_LIMITS.maxCostUsd * 0.8, 2);
  });
});
