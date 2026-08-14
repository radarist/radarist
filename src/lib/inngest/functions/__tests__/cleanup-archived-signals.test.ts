/** @jest-environment node */

const mockGetPlatformConfig = jest.fn();
const mockGetArchivedSignals = jest.fn();
const mockCleanupArchivedSignals = jest.fn();
const mockSend = jest.fn();

jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_config: unknown, _trigger: unknown, handler: unknown) => handler,
    send: (...args: unknown[]) => mockSend(...args),
  },
}));
jest.mock('@/lib/platform-config-admin', () => ({
  adminGetPlatformConfig: (...args: unknown[]) => mockGetPlatformConfig(...args),
}));
jest.mock('@/lib/signals-admin', () => ({
  adminGetArchivedSignals: (...args: unknown[]) => mockGetArchivedSignals(...args),
  adminCleanupArchivedSignals: (...args: unknown[]) => mockCleanupArchivedSignals(...args),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { cleanupArchivedSignalsJob } = require('../cleanup-archived-signals') as typeof import('../cleanup-archived-signals');

const step = {
  run: (_name: string, fn: () => unknown) => fn(),
};

function runJob() {
  return (cleanupArchivedSignalsJob as unknown as (input: { step: typeof step }) => Promise<unknown>)({ step });
}

describe('cleanupArchivedSignalsJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPlatformConfig.mockResolvedValue({ archiveRetentionDays: 365 });
    mockGetArchivedSignals.mockResolvedValue([]);
    mockCleanupArchivedSignals.mockResolvedValue({ deleted: 0, failed: [] });
    mockSend.mockResolvedValue(undefined);
  });

  it('uses the validated persisted retention policy', async () => {
    await expect(runJob()).resolves.toMatchObject({ success: true, retentionDays: 365 });
    expect(mockCleanupArchivedSignals).toHaveBeenCalledWith(365);
  });

  it('performs no destructive work when the retention policy cannot be read', async () => {
    mockGetPlatformConfig.mockRejectedValue(new Error('Firestore unavailable'));

    await expect(runJob()).rejects.toThrow('Firestore unavailable');
    expect(mockGetArchivedSignals).not.toHaveBeenCalled();
    expect(mockCleanupArchivedSignals).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
