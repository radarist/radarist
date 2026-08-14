/** @jest-environment node */

import { stopAndRemoveDockerContainer } from '../lib/docker-container-cleanup';

describe('stopAndRemoveDockerContainer', () => {
  it('force-removes a container that still exists after stop and proves absence', async () => {
    const calls: string[] = [];
    let exists = true;

    await stopAndRemoveDockerContainer(
      'owned-container',
      {
        stop: (reference) => calls.push(`stop:${reference}`),
        forceRemove: (reference) => {
          calls.push(`rm:${reference}`);
          exists = false;
        },
        exists: () => exists,
      },
      { pollAttempts: 2, pollIntervalMs: 0 }
    );

    expect(calls).toEqual(['stop:owned-container', 'rm:owned-container']);
  });

  it('accepts a removal error only when bounded polling proves absence', async () => {
    const removeFailure = new Error('No such container');

    await expect(
      stopAndRemoveDockerContainer('auto-removed', {
        stop: jest.fn(),
        forceRemove: () => {
          throw removeFailure;
        },
        exists: () => false,
      })
    ).resolves.toBeUndefined();

    await expect(
      stopAndRemoveDockerContainer(
        'still-present',
        {
          stop: jest.fn(),
          forceRemove: () => {
            throw removeFailure;
          },
          exists: () => true,
        },
        { pollAttempts: 1, pollIntervalMs: 0 }
      )
    ).rejects.toThrow('Docker container still-present still exists after cleanup.');
  });

  it('waits through a redacted auto-removal error while Docker finishes removal', async () => {
    const observations = [true, false];
    const waits: number[] = [];

    await expect(
      stopAndRemoveDockerContainer(
        'auto-removing',
        {
          stop: jest.fn(),
          forceRemove: () => {
            throw new Error('docker exited with code 1; arguments were redacted');
          },
          exists: () => observations.shift() ?? false,
          wait: async (milliseconds) => {
            waits.push(milliseconds);
          },
        },
        { pollAttempts: 3, pollIntervalMs: 25 }
      )
    ).resolves.toBeUndefined();

    expect(waits).toEqual([25]);
  });

  it('fails when removal returns but the container never disappears', async () => {
    const waits: number[] = [];

    await expect(
      stopAndRemoveDockerContainer(
        'wedged-container',
        {
          stop: jest.fn(),
          forceRemove: jest.fn(),
          exists: () => true,
          wait: async (milliseconds) => {
            waits.push(milliseconds);
          },
        },
        { pollAttempts: 3, pollIntervalMs: 25 }
      )
    ).rejects.toThrow('Docker container wedged-container still exists after cleanup.');

    expect(waits).toEqual([25, 25]);
  });
});
