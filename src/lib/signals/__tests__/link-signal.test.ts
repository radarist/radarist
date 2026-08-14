jest.mock('server-only', () => ({}));

const mockGenForSignal = jest.fn();
const mockVerify = jest.fn();
jest.mock('@/lib/linker', () => ({
  __esModule: true,
  generateCandidatesForSignal: (...a: unknown[]) => mockGenForSignal(...a),
  verifyCandidatesWithAI: (...a: unknown[]) => mockVerify(...a),
}));

const mockCreateProposal = jest.fn();
jest.mock('@/lib/proposed-relations-admin', () => ({
  __esModule: true,
  createProposedRelationIfNotExists: (...a: unknown[]) => mockCreateProposal(...a),
}));

import { linkSignalNow } from '../link-signal';

const candidate = (over: Record<string, unknown> = {}) => ({
  sourceId: 'sig-1',
  sourceType: 'signal',
  sourceName: 'A signal',
  targetId: 'tech-1',
  targetType: 'technology',
  targetName: 'A tech',
  relationType: 'mentions',
  confidence: 80,
  discoveryMethod: 'heuristic',
  evidenceSnippets: ['Matched on: tags'],
  ...over,
});

describe('linkSignalNow', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns zeros and creates nothing when there are no candidates', async () => {
    mockGenForSignal.mockResolvedValue([]);

    const res = await linkSignalNow('sig-1');

    expect(res).toEqual({ candidates: 0, verified: 0, created: 0 });
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('verifies candidates and persists each verified one as a proposed relation', async () => {
    mockGenForSignal.mockResolvedValue([candidate(), candidate({ targetId: 'tech-2' })]);
    mockVerify.mockResolvedValue([candidate(), candidate({ targetId: 'tech-2' })]);
    mockCreateProposal.mockResolvedValue({ created: true });

    const res = await linkSignalNow('sig-1');

    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockCreateProposal).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ candidates: 2, verified: 2, created: 2 });
  });

  it('counts only newly-created proposals (idempotent skips)', async () => {
    mockGenForSignal.mockResolvedValue([candidate(), candidate({ targetId: 'tech-2' })]);
    mockVerify.mockResolvedValue([candidate(), candidate({ targetId: 'tech-2' })]);
    mockCreateProposal
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: false, reason: 'already_pending' });

    const res = await linkSignalNow('sig-1');

    expect(res.created).toBe(1);
    expect(res.verified).toBe(2);
  });

  it('never throws — a generation failure returns zeros (best-effort)', async () => {
    mockGenForSignal.mockRejectedValue(new Error('boom'));

    const res = await linkSignalNow('sig-1');

    expect(res).toEqual({ candidates: 0, verified: 0, created: 0 });
  });

  it('survives a per-candidate persistence error without throwing', async () => {
    mockGenForSignal.mockResolvedValue([candidate(), candidate({ targetId: 'tech-2' })]);
    mockVerify.mockResolvedValue([candidate(), candidate({ targetId: 'tech-2' })]);
    mockCreateProposal.mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce({ created: true });

    const res = await linkSignalNow('sig-1');

    expect(res.created).toBe(1);
  });
});
