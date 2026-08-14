/**
 * @file run-linker-cycle.test.ts
 * @description Unit tests for the Inngest linker cycle handler.
 */

jest.mock('@/lib/linker', () => ({
  generateCandidates: jest.fn(),
  verifyCandidatesWithAI: jest.fn(),
}));
jest.mock('@/lib/proposed-relations-admin', () => ({
  createProposedRelationIfNotExists: jest.fn(),
}));
const mockSystemConfigGet = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({ get: (...args: unknown[]) => mockSystemConfigGet(...args) })),
    })),
  },
}));
jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      handler,
      execute: (data: unknown) =>
        handler({
          event: { data },
          step: { run: async (_name: string, fn: () => unknown) => fn() },
        }),
    })),
    send: jest.fn(),
  },
}));

import * as linker from '@/lib/linker';
import * as proposed from '@/lib/proposed-relations-admin';
import { runLinkerCycleJob } from '../run-linker-cycle';

const mockedGen = linker.generateCandidates as jest.Mock;
const mockedVerify = linker.verifyCandidatesWithAI as jest.Mock;
const mockedCreate = proposed.createProposedRelationIfNotExists as jest.Mock;

const makeCandidate = (i: number) => ({
  sourceId: `s${i}`,
  sourceType: 'technology',
  sourceName: `Tech ${i}`,
  targetId: `t${i}`,
  targetType: 'company',
  targetName: `Co ${i}`,
  relationType: 'USES',
  confidence: 80,
  discoveryMethod: 'heuristic' as const,
  evidenceSnippets: ['evidence snippet'],
});

describe('runLinkerCycleJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSystemConfigGet.mockResolvedValue({
      exists: true,
      data: () => ({
        sweep: { enabled: true, maxActionsPerSweep: 10 },
        linkerAgent: { enabled: true },
      }),
    });
    mockedCreate.mockResolvedValue({ created: true, proposal: { id: 'p1' } });
  });

  it('fails closed when the master automation switch is paused', async () => {
    mockSystemConfigGet.mockResolvedValue({
      exists: true,
      data: () => ({
        sweep: { enabled: false, maxActionsPerSweep: 10 },
        linkerAgent: { enabled: true },
      }),
    });

    const result = await (runLinkerCycleJob as any).execute({});

    expect(result).toMatchObject({ action: 'disabled', candidatesGenerated: 0 });
    expect(mockedGen).not.toHaveBeenCalled();
  });

  it('fails closed when linker is disabled or the config read fails', async () => {
    mockSystemConfigGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        sweep: { enabled: true, maxActionsPerSweep: 10 },
        linkerAgent: { enabled: false },
      }),
    });
    expect(await (runLinkerCycleJob as any).execute({})).toMatchObject({ action: 'disabled' });

    mockSystemConfigGet.mockRejectedValueOnce(new Error('Firestore unavailable'));
    expect(await (runLinkerCycleJob as any).execute({})).toMatchObject({ action: 'disabled' });
    expect(mockedGen).not.toHaveBeenCalled();
  });

  it('generates, verifies, and creates a proposed relation per verified candidate', async () => {
    mockedGen.mockResolvedValue([makeCandidate(1), makeCandidate(2)]);
    mockedVerify.mockResolvedValue([makeCandidate(1), makeCandidate(2)]);

    const r = await (runLinkerCycleJob as any).execute({});

    expect(r.candidatesGenerated).toBe(2);
    expect(r.candidatesVerified).toBe(2);
    expect(r.proposedRelationsCreated).toBe(2);
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  it('honours dryRun — generates + verifies but does not create', async () => {
    mockedGen.mockResolvedValue([makeCandidate(1)]);
    mockedVerify.mockResolvedValue([makeCandidate(1)]);

    const r = await (runLinkerCycleJob as any).execute({ dryRun: true });

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(r.proposedRelationsCreated).toBe(0);
    expect(r.candidatesVerified).toBe(1);
  });

  it('does not increment proposedRelationsCreated when an existing proposal is returned', async () => {
    mockedGen.mockResolvedValue([makeCandidate(1), makeCandidate(2)]);
    mockedVerify.mockResolvedValue([makeCandidate(1), makeCandidate(2)]);
    mockedCreate
      .mockResolvedValueOnce({ created: true, proposal: { id: 'p1' } })
      .mockResolvedValueOnce({ created: false, proposal: { id: 'p2' }, reason: 'already_pending' });

    const r = await (runLinkerCycleJob as any).execute({});

    expect(r.proposedRelationsCreated).toBe(1);
  });

  it('isolates per-candidate createProposedRelationIfNotExists failures', async () => {
    mockedGen.mockResolvedValue([makeCandidate(1), makeCandidate(2)]);
    mockedVerify.mockResolvedValue([makeCandidate(1), makeCandidate(2)]);
    mockedCreate
      .mockRejectedValueOnce(new Error('firestore timeout'))
      .mockResolvedValueOnce({ created: true, proposal: { id: 'p2' } });

    const r = await (runLinkerCycleJob as any).execute({});

    expect(r.proposedRelationsCreated).toBe(1);
  });

  it('returns zeroes when generator produces no candidates', async () => {
    mockedGen.mockResolvedValue([]);
    mockedVerify.mockResolvedValue([]);

    const r = await (runLinkerCycleJob as any).execute({});

    expect(r.candidatesGenerated).toBe(0);
    expect(r.candidatesVerified).toBe(0);
    expect(r.proposedRelationsCreated).toBe(0);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
