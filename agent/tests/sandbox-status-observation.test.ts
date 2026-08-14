import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';

import { readStatus, readStatusObservation } from '../src/sandbox/status.js';
import type { ExecResult, SandboxDriver, SandboxRef } from '../src/sandbox/types.js';

const ref = { missionId: 'status-observation' } as SandboxRef;
const now = '2026-07-19T10:00:00.000Z';

function driverReturning(result: ExecResult): {
  driver: SandboxDriver;
  exec: jest.Mock;
} {
  const exec = jest.fn(async () => result);
  return {
    driver: { exec } as unknown as SandboxDriver,
    exec,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('sandbox status observations', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns a validated status and digest of the exact file bytes', async () => {
    const raw = JSON.stringify({
      phase: '06-build',
      stories: [{ id: 'S1', title: 'Implement the preview', status: 'done' }],
    });
    const { driver, exec } = driverReturning({ code: 0, stdout: raw, stderr: '' });

    await expect(readStatusObservation(driver, ref)).resolves.toEqual({
      attemptedAt: now,
      health: 'valid',
      status: {
        phase: '06-build',
        readyForQa: false,
        stories: [
          {
            id: 'S1',
            title: 'Implement the preview',
            status: 'done',
            cuttable: false,
          },
        ],
        blocked: null,
        handoff: null,
        notes: [],
      },
      digest: sha256(raw),
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(ref, ['cat', '.impulse/STATUS.json']);
  });

  it('classifies a missing status file without inventing a digest', async () => {
    const { driver } = driverReturning({
      code: 1,
      stdout: '',
      stderr: 'cat: .impulse/STATUS.json: No such file or directory',
    });

    await expect(readStatusObservation(driver, ref)).resolves.toEqual({
      attemptedAt: now,
      health: 'missing',
      status: null,
      digest: null,
    });
  });

  it('classifies malformed JSON while retaining its raw-byte digest', async () => {
    const raw = '{not-json';
    const { driver } = driverReturning({ code: 0, stdout: raw, stderr: '' });

    await expect(readStatusObservation(driver, ref)).resolves.toEqual({
      attemptedAt: now,
      health: 'malformed',
      status: null,
      digest: sha256(raw),
    });
  });

  it('keeps readStatus backward-compatible for valid files', async () => {
    const raw = JSON.stringify({
      phase: '08-qa',
      readyForQa: true,
      stories: [],
      notes: ['QA is ready'],
    });
    const { driver } = driverReturning({ code: 0, stdout: raw, stderr: '' });

    await expect(readStatus(driver, ref)).resolves.toEqual({
      phase: '08-qa',
      readyForQa: true,
      stories: [],
      blocked: null,
      handoff: null,
      notes: ['QA is ready'],
    });
  });

  it.each([
    ['missing', { code: 1, stdout: '', stderr: 'missing' }],
    ['malformed', { code: 0, stdout: '{bad-json', stderr: '' }],
  ] as const)('keeps readStatus backward-compatible for %s files', async (_case, result) => {
    const { driver } = driverReturning(result);

    await expect(readStatus(driver, ref)).resolves.toBeNull();
  });
});
