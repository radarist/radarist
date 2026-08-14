/** @jest-environment node */

export {};

type Handler = (input: { step: { run: (name: string, fn: () => unknown) => unknown } }) => Promise<unknown>;

const mockSend = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/inngest/client', () => {
  const registry: { handlers: Record<string, Handler> } = { handlers: {} };
  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: { id: string }, _trigger: unknown, handler: Handler) => {
        registry.handlers[config.id] = handler;
        return { config, handler };
      }),
      send: (...args: unknown[]) => mockSend(...args),
    },
    _registry: registry,
  };
});

function getHandler(id: string): Handler {
  const clientMock = require('@/lib/inngest/client') as { _registry: { handlers: Record<string, Handler> } };
  return clientMock._registry.handlers[id];
}

const mockIsMaintenancePaused = jest.fn();
jest.mock('@/lib/maintenance-policy', () => ({
  __esModule: true,
  isMaintenancePaused: () => mockIsMaintenancePaused(),
  maintenanceSkip: (functionId: string) => ({ skipped: true, functionId }),
}));

const mockListPending = jest.fn();
const mockClearPending = jest.fn();
jest.mock('@/lib/technology-research-admin', () => ({
  __esModule: true,
  listTechnologiesWithPendingSnapshotRefresh: (...args: unknown[]) => mockListPending(...args),
  clearPendingSnapshotRefresh: (...args: unknown[]) => mockClearPending(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import '../functions/replay-pending-snapshot-refreshes';

const HANDLER_ID = 'replay-pending-snapshot-refreshes';
const step = { run: (_name: string, fn: () => unknown) => fn() };

describe('replayPendingSnapshotRefreshesJob (ARUN-028)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ ids: ['evt-1'] });
    mockIsMaintenancePaused.mockReturnValue(false);
    mockClearPending.mockResolvedValue(true);
  });

  it('re-dispatches each missed refresh idempotently and clears its debt on success', async () => {
    mockListPending.mockResolvedValue([
      { id: 'tech-1', attemptToken: 111 },
      { id: 'tech-2', attemptToken: 222 },
    ]);

    const result = await getHandler(HANDLER_ID)({ step });

    expect(mockSend).toHaveBeenCalledWith({
      name: 'app/technology.updated',
      data: { technologyId: 'tech-1', updatedFields: [] },
    });
    expect(mockSend).toHaveBeenCalledWith({
      name: 'app/technology.updated',
      data: { technologyId: 'tech-2', updatedFields: [] },
    });
    expect(mockClearPending).toHaveBeenCalledWith('tech-1', 111);
    expect(mockClearPending).toHaveBeenCalledWith('tech-2', 222);
    expect(result).toEqual({ replayed: 2, cleared: 2, failed: 0 });
  });

  it('retains the debt (does not clear) when a re-dispatch fails', async () => {
    mockListPending.mockResolvedValue([{ id: 'tech-1', attemptToken: 111 }]);
    mockSend.mockRejectedValueOnce(new Error('still down'));

    const result = await getHandler(HANDLER_ID)({ step });

    expect(mockClearPending).not.toHaveBeenCalled();
    expect(result).toEqual({ replayed: 0, cleared: 0, failed: 1 });
  });

  it('retains the debt when a re-dispatch resolves with no accepted ids (kill switch)', async () => {
    mockListPending.mockResolvedValue([{ id: 'tech-1', attemptToken: 111 }]);
    mockSend.mockResolvedValueOnce({ ids: [] });

    const result = await getHandler(HANDLER_ID)({ step });

    // A phantom (empty-ids) send must NEVER destroy durable debt.
    expect(mockClearPending).not.toHaveBeenCalled();
    expect(result).toEqual({ replayed: 0, cleared: 0, failed: 1 });
  });

  it('does nothing when there is no outstanding debt', async () => {
    mockListPending.mockResolvedValue([]);

    const result = await getHandler(HANDLER_ID)({ step });

    expect(mockSend).not.toHaveBeenCalled();
    expect(result).toEqual({ replayed: 0, cleared: 0, failed: 0 });
  });

  it('skips entirely while maintenance is paused', async () => {
    mockIsMaintenancePaused.mockReturnValue(true);

    const result = await getHandler(HANDLER_ID)({ step });

    expect(result).toMatchObject({ skipped: true });
    expect(mockListPending).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
