/** @jest-environment node */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  derivePublicLocalRuntimeHealth,
  parseLocalRuntimeStatus,
  readPublicLocalRuntimeHealth,
  type LocalRuntimeStatusFile,
} from '../local-runtime-status';

const HEALTHY: LocalRuntimeStatusFile = {
  schemaVersion: 1,
  profile: 'default',
  projectId: 'demo-radarist',
  startedAt: '2026-07-18T12:00:00.000Z',
  updatedAt: '2026-07-18T12:05:00.000Z',
  supervisor: { state: 'running', unexpectedExit: false, orphanCount: 0 },
  checkpoint: { state: 'healthy', lastSuccessAt: '2026-07-18T12:05:00.000Z' },
};

describe('local runtime public health', () => {
  it('reports a recent durable checkpoint as healthy without exposing paths', () => {
    const status = { ...HEALTHY, updatedAt: '2026-07-18T12:09:50.000Z' };
    expect(derivePublicLocalRuntimeHealth(status, Date.parse('2026-07-18T12:10:00Z'))).toEqual({
      status: 'up',
      supervisor: 'running',
      checkpoint: 'healthy',
      checkpointAgeMs: 300_000,
      heartbeatAgeMs: 10_000,
      orphanCount: 0,
    });
  });

  it('degrades after the RPO plus grace window', () => {
    const status = { ...HEALTHY, updatedAt: '2026-07-18T12:16:00.000Z' };
    expect(
      derivePublicLocalRuntimeHealth(status, Date.parse('2026-07-18T12:16:01Z'))
    ).toMatchObject({ status: 'down', checkpoint: 'degraded' });
  });

  it('fails health when the launcher heartbeat expires even if the child app remains up', () => {
    expect(
      derivePublicLocalRuntimeHealth(HEALTHY, Date.parse('2026-07-18T12:05:46Z'))
    ).toMatchObject({
      status: 'down',
      heartbeatAgeMs: 46_000,
      error: 'local runtime requires attention',
    });
  });

  it.each([
    { supervisor: { state: 'degraded', unexpectedExit: false, orphanCount: 0 } },
    { supervisor: { state: 'running', unexpectedExit: true, orphanCount: 0 } },
    { supervisor: { state: 'running', unexpectedExit: false, orphanCount: 1 } },
    { checkpoint: { state: 'degraded' } },
  ])('degrades for supervisor/checkpoint fault %#', (change) => {
    const status = {
      ...HEALTHY,
      supervisor: { ...HEALTHY.supervisor, ...change.supervisor },
      checkpoint: { ...HEALTHY.checkpoint, ...change.checkpoint },
    } as LocalRuntimeStatusFile;
    expect(derivePublicLocalRuntimeHealth(status, Date.parse('2026-07-18T12:05:30Z')).status).toBe(
      'down'
    );
  });

  it('fails closed for malformed status and does not echo its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radarist-runtime-health-'));
    const file = join(dir, 'private-secret-path.json');
    writeFileSync(file, '{"schemaVersion":999}');
    const result = readPublicLocalRuntimeHealth(file);
    expect(result).toMatchObject({ status: 'down', error: 'local runtime status is unavailable' });
    expect(JSON.stringify(result)).not.toContain(file);
    rmSync(dir, { recursive: true, force: true });
  });

  it('distinguishes an intentionally unconfigured runtime', () => {
    expect(readPublicLocalRuntimeHealth(undefined)).toEqual({
      status: 'not-configured',
      supervisor: 'not-configured',
      checkpoint: 'not-configured',
    });
  });

  it('rejects non-demo projects and invalid timestamps', () => {
    expect(() => parseLocalRuntimeStatus({ ...HEALTHY, projectId: 'production' })).toThrow(
      /invalid runtime status/
    );
    expect(() => parseLocalRuntimeStatus({ ...HEALTHY, updatedAt: 'not-a-date' })).toThrow(
      /invalid runtime status/
    );
  });
});
