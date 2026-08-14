/**
 * F106: executeCurateRelation must not let a machine self-release the
 * materialization gate. Promoting a relation to 'curated' materializes the
 * withheld typed edge in sync-assertion-to-neo4j, so it is a HUMAN review
 * action — it requires an authenticated user in context. Non-'curated'
 * transitions are unaffected.
 */

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/relations-admin', () => ({
  adminGetRelationById: jest.fn(),
  adminCreateRelationFromIds: jest.fn(),
  adminDeleteRelation: jest.fn(),
  adminUpdateRelation: jest.fn(),
}));
jest.mock('@/lib/graph', () => ({
  getAssertionWithEvidence: jest.fn(),
  getAssertionWithEvidenceByRelationId: jest.fn(),
  explainConnection: jest.fn(),
  getAssertionsForEntity: jest.fn(),
  runReadTransaction: jest.fn(),
}));
jest.mock('@/lib/inngest/client', () => ({
  sendEvent: jest.fn(),
  inngest: { send: jest.fn() },
}));

import * as relationsAdmin from '@/lib/relations-admin';
import { sendEvent } from '@/lib/inngest/client';
import { executeCurateRelation } from '../assertions-tools';

const mockedGet = relationsAdmin.adminGetRelationById as jest.Mock;
const mockedUpdate = relationsAdmin.adminUpdateRelation as jest.Mock;
const mockedSendEvent = sendEvent as jest.Mock;

function baseRelation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rel-1',
    relationType: 'uses',
    confidence: 60,
    claimStatus: 'proposed',
    claimId: 'claim-1',
    notes: null,
    ...overrides,
  } as unknown;
}

describe('executeCurateRelation human-context gate (F106)', () => {
  beforeEach(() => jest.clearAllMocks());

  it("refuses to promote to 'curated' with no principal (machine default)", async () => {
    const result = await executeCurateRelation({ relationId: 'rel-1', status: 'curated' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/human review action/i);
    // Must not touch the relation or fire the materialization release event.
    expect(mockedGet).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedSendEvent).not.toHaveBeenCalled();
  });

  it('refuses a machine caller that carries a userId (presence != human — the F106 core)', async () => {
    // Every machine dispatch supplies a truthy userId (apiKey.userId,
    // 'anonymous', a mission id). The guard must key on principal, not userId.
    const result = await executeCurateRelation(
      { relationId: 'rel-1', status: 'curated' },
      { userId: 'apikey-user-123', principal: 'machine' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/human review action/i);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedSendEvent).not.toHaveBeenCalled();
  });

  it("allows a human principal to promote to 'curated' and fires the release event", async () => {
    mockedGet.mockResolvedValue(baseRelation());

    const result = await executeCurateRelation(
      { relationId: 'rel-1', status: 'curated' },
      { userId: 'claudio', principal: 'human' }
    );

    expect(result.success).toBe(true);
    expect(mockedUpdate).toHaveBeenCalledWith(
      'rel-1',
      expect.objectContaining({ claimStatus: 'curated', notes: expect.stringContaining('user:claudio') })
    );
    expect(mockedSendEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'app/claim.sync.requested' }));
  });

  it("allows a machine to set non-'curated' statuses (e.g. 'rejected')", async () => {
    mockedGet.mockResolvedValue(baseRelation({ claimStatus: 'proposed' }));

    const result = await executeCurateRelation({ relationId: 'rel-1', status: 'rejected' });

    expect(result.success).toBe(true);
    expect(mockedUpdate).toHaveBeenCalledWith('rel-1', expect.objectContaining({ claimStatus: 'rejected' }));
  });
});
