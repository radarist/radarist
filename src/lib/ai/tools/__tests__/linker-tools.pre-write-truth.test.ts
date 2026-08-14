/**
 * @file linker-tools.pre-write-truth.test.ts
 * @description AI-047 — a write-classified tool must PROVE whether it mutated
 * anything, and the proof must survive exactly one boundary: the latch it opens
 * immediately before its first mutating call.
 *
 * Each case pins one refusal stage (validation, lookup,
 * authorization, machine principal, thrown-before-write) plus the one case that
 * must stay conservative: a throw AFTER a mutation was attempted.
 */

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/relations-admin', () => {
  class DuplicateRelationError extends Error {
    existingRelation: { id: string };
    constructor(existingRelation: { id: string }) {
      super('dup');
      this.name = 'DuplicateRelationError';
      this.existingRelation = existingRelation;
    }
  }
  return {
    adminCreateRelationFromIds: jest.fn(),
    adminCheckDuplicateRelation: jest.fn().mockResolvedValue(null),
    adminUpdateRelationFromFreshState: jest.fn(),
    buildEntitySnapshot: jest.fn(),
    DuplicateRelationError,
  };
});
jest.mock('@/lib/proposed-relations-admin', () => ({
  createProposedRelationIfNotExists: jest.fn(),
  attachMaterializedRelationToProposal: jest.fn(),
  relationMatchesProposal: jest.fn(() => true),
  getProposedRelations: jest.fn().mockResolvedValue([]),
  getProposedRelationById: jest.fn().mockResolvedValue(null),
  getProposedRelationByKey: jest.fn().mockResolvedValue(null),
  approveProposedRelation: jest.fn(),
  rejectProposedRelation: jest.fn(),
  dismissProposedRelation: jest.fn(),
  bulkApproveProposedRelations: jest.fn(),
}));
// AI-039 — stub the name-endpoint helper so this suite does not load the admin
// entity readers (and firebase-admin) transitively via `createRelations`.
jest.mock('@/lib/ai/tools/helpers/resolve-entity-endpoint', () => ({
  __esModule: true,
  resolveEntityEndpointByExactName: jest.fn(),
  describeEntityEndpointFailure: (failure: { kind: string }) => failure.kind,
}));
jest.mock('@/lib/linker/relation-ontology', () => ({
  validateRelation: jest.fn().mockReturnValue({ valid: true, shouldSwap: false }),
}));
jest.mock('@/lib/linker/confidence-config', () => ({
  getConfidenceThreshold: jest.fn().mockReturnValue(75),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn(() => Promise.resolve()),
}));

import {
  executeApproveProposedRelation,
  executeBulkApproveHighConfidenceProposals,
  executeCreateRelation,
} from '../linker-tools';
import { adminCheckDuplicateRelation, adminCreateRelationFromIds, buildEntitySnapshot } from '@/lib/relations-admin';
import {
  approveProposedRelation,
  bulkApproveProposedRelations,
  getProposedRelationById,
  getProposedRelations,
} from '@/lib/proposed-relations-admin';
import { validateRelation } from '@/lib/linker/relation-ontology';
import { readNoMutationProof } from '@/lib/ai/tool-side-effects';
import { classifyChatToolCall } from '@/lib/ai/chat-turn-outcome';
import type { ToolResult } from '@/lib/ai/tools/tool-result';
import type { ProposedRelation } from '@/lib/types';

const mockValidateRelation = validateRelation as jest.MockedFunction<typeof validateRelation>;
const mockBuildEntitySnapshot = buildEntitySnapshot as jest.MockedFunction<typeof buildEntitySnapshot>;
const mockAdminCreateRelationFromIds = adminCreateRelationFromIds as jest.MockedFunction<
  typeof adminCreateRelationFromIds
>;
const mockAdminCheckDuplicateRelation = adminCheckDuplicateRelation as jest.MockedFunction<
  typeof adminCheckDuplicateRelation
>;
const mockGetProposedRelations = getProposedRelations as jest.MockedFunction<typeof getProposedRelations>;
const mockBulkApproveProposedRelations = bulkApproveProposedRelations as jest.MockedFunction<
  typeof bulkApproveProposedRelations
>;
const mockGetProposedRelationById = getProposedRelationById as jest.MockedFunction<typeof getProposedRelationById>;
const mockApproveProposedRelation = approveProposedRelation as jest.MockedFunction<typeof approveProposedRelation>;

/** Synthetic document-to-pain-point relation arguments. */
const linkArgs = {
  sourceId: 'document-1',
  sourceType: 'document',
  targetId: 'pain-point-1',
  targetType: 'painPoint',
  relationType: 'custom',
} as const;

const humanTurn = {
  principal: 'human' as const,
  confirmationText: 'Link document document-1 to pain point pain-point-1.',
};

function resolveEndpoints() {
  mockBuildEntitySnapshot.mockImplementation(async (id, type) => ({
    id,
    type,
    name: type === 'document' ? 'Quantum Briefing' : 'Slow triage',
    snapshotAt: 100,
  }));
}

describe('executeCreateRelation — pre-write failures prove no mutation (AI-047)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateRelation.mockReturnValue({ valid: true, shouldSwap: false });
    mockAdminCheckDuplicateRelation.mockResolvedValue(null);
    mockAdminCreateRelationFromIds.mockResolvedValue({ id: 'relation-1' } as Awaited<
      ReturnType<typeof adminCreateRelationFromIds>
    >);
    resolveEndpoints();
  });

  it('proves a lookup failure wrote nothing and names the unresolved endpoint', async () => {
    mockBuildEntitySnapshot.mockImplementation(async (id, type) => {
      if (type === 'painPoint') throw new Error(`PainPoint not found: ${id}`);
      return { id, type, name: 'Quantum Briefing', snapshotAt: 100 };
    });

    const result = await executeCreateRelation(linkArgs, humanTurn);

    expect(result.success).toBe(false);
    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'lookup' });
    // The real cause survives — this is what the operator lost twice in one session.
    expect(result.error).toContain('PainPoint not found: pain-point-1');
    expect(result.error).toContain('target');
    expect(result.data?.dispatched).toBe(false);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('reports BOTH endpoints when neither resolves', async () => {
    mockBuildEntitySnapshot.mockImplementation(async (id, type) => {
      throw new Error(`${type} not found: ${id}`);
    });

    const result = await executeCreateRelation(linkArgs, humanTurn);

    expect(readNoMutationProof(result)?.stage).toBe('lookup');
    expect(result.error).toContain('document not found: document-1');
    expect(result.error).toContain('painPoint not found: pain-point-1');
  });

  it('proves an ontology validation refusal wrote nothing, before any entity read', async () => {
    mockValidateRelation.mockReturnValueOnce({
      valid: false,
      shouldSwap: false,
      error: 'document cannot "depends_on" a painPoint',
    });

    const result = await executeCreateRelation({ ...linkArgs, relationType: 'depends_on' }, humanTurn);

    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'validation' });
    expect(result.error).toBe('document cannot "depends_on" a painPoint');
    expect(mockBuildEntitySnapshot).not.toHaveBeenCalled();
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('proves a missing-argument call wrote nothing and names the arguments', async () => {
    const result = await executeCreateRelation({ sourceId: 'document-1', sourceType: 'document' }, humanTurn);

    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'validation' });
    expect(result.error).toContain('targetId');
    expect(result.error).toContain('targetType');
    expect(result.error).toContain('relationType');
    expect(mockValidateRelation).not.toHaveBeenCalled();
    expect(mockBuildEntitySnapshot).not.toHaveBeenCalled();
  });

  it('proves an unauthorized turn wrote nothing', async () => {
    const result = await executeCreateRelation(linkArgs, {
      principal: 'human',
      confirmationText: 'Tell me about the quantum briefing.',
    });

    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'authorization' });
    expect(result.error).toContain('not authorized');
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('proves a pre-write throw wrote nothing (the duplicate probe is a read)', async () => {
    mockAdminCheckDuplicateRelation.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const result = await executeCreateRelation(linkArgs, humanTurn);

    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'unexpected' });
    expect(result.error).toBe('Firestore unavailable');
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('stays conservative when the throw happens AFTER the write was attempted', async () => {
    mockAdminCreateRelationFromIds.mockRejectedValueOnce(new Error('write timed out mid-commit'));

    const result = await executeCreateRelation(linkArgs, humanTurn);

    expect(result.success).toBe(false);
    // No proof: the mutation had already started, so the outcome is genuinely
    // unknown and must keep the conservative, never-retried path.
    expect(readNoMutationProof(result)).toBeUndefined();
    expect(result.error).toBe('write timed out mid-commit');
  });

  it('never claims no-mutation on a successful write', async () => {
    const result = await executeCreateRelation(linkArgs, humanTurn);

    expect(result.success).toBe(true);
    expect(readNoMutationProof(result)).toBeUndefined();
    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledTimes(1);
  });
});

/**
 * The single-proposal approve gate is the Assistant's MOST frequent policy
 * refusal — the model proposes a relation and immediately tries to approve it,
 * and the route declines by design. Its bulk sibling and `executeCreateRelation`
 * both stamp the proof; this one did not, so a turn that behaved exactly as
 * designed classified as `failed` and the durable AgentRun read `partial`.
 * That is the AI-042 defect inverted: the headline still contradicts the row.
 */
describe('executeApproveProposedRelation — policy refusals prove no mutation (AI-047/AI-042)', () => {
  const proposal = {
    id: 'proposal-9',
    status: 'pending',
    runId: 'chat:staging-turn',
  } as unknown as ProposedRelation;

  beforeEach(() => {
    mockGetProposedRelationById.mockResolvedValue(proposal);
    mockApproveProposedRelation.mockResolvedValue({
      relationId: 'rel-9',
      sourceSnapshot: { name: 'Source' },
      targetSnapshot: { name: 'Target' },
    } as unknown as Awaited<ReturnType<typeof approveProposedRelation>>);
  });

  it('proves a machine principal approved nothing and never reads the proposal', async () => {
    const result = await executeApproveProposedRelation(
      { proposalId: 'proposal-9' },
      { principal: 'machine', confirmationText: 'approve proposal proposal-9', userId: 'u1' }
    );

    expect(result.success).toBe(false);
    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'principal' });
    expect(mockGetProposedRelationById).not.toHaveBeenCalled();
    expect(mockApproveProposedRelation).not.toHaveBeenCalled();
  });

  it('proves an unauthorized human turn approved nothing', async () => {
    const result = await executeApproveProposedRelation(
      { proposalId: 'proposal-9' },
      { principal: 'human', confirmationText: 'what did you find?', userId: 'u1' }
    );

    expect(result.success).toBe(false);
    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'authorization' });
    expect(mockApproveProposedRelation).not.toHaveBeenCalled();
  });

  it('proves a same-turn self-approval approved nothing', async () => {
    const result = await executeApproveProposedRelation(
      { proposalId: 'proposal-9' },
      {
        principal: 'human',
        confirmationText: 'approve proposal proposal-9',
        userId: 'u1',
        requestId: 'staging-turn',
      }
    );

    expect(result.success).toBe(false);
    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'authorization' });
    expect(mockApproveProposedRelation).not.toHaveBeenCalled();
  });

  it('records every one of those refusals as a designed outcome, not a failure', async () => {
    const refusals = await Promise.all([
      executeApproveProposedRelation(
        { proposalId: 'proposal-9' },
        { principal: 'machine', confirmationText: 'approve proposal proposal-9', userId: 'u1' }
      ),
      executeApproveProposedRelation(
        { proposalId: 'proposal-9' },
        { principal: 'human', confirmationText: 'what did you find?', userId: 'u1' }
      ),
      executeApproveProposedRelation(
        { proposalId: 'proposal-9' },
        {
          principal: 'human',
          confirmationText: 'approve proposal proposal-9',
          userId: 'u1',
          requestId: 'staging-turn',
        }
      ),
    ]);

    for (const refusal of refusals) {
      expect(classifyChatToolCall({ name: 'approveProposedRelation', result: refusal as ToolResult })).toBe('refused');
    }
  });

  it('still approves an authorized later turn, and claims no proof when it writes', async () => {
    const result = await executeApproveProposedRelation(
      { proposalId: 'proposal-9' },
      {
        principal: 'human',
        confirmationText: 'approve proposal proposal-9',
        userId: 'u1',
        requestId: 'a-later-turn',
      }
    );

    expect(result.success).toBe(true);
    expect(readNoMutationProof(result)).toBeUndefined();
    expect(mockApproveProposedRelation).toHaveBeenCalledTimes(1);
  });

  it('stays conservative when the approval itself throws', async () => {
    mockApproveProposedRelation.mockRejectedValueOnce(new Error('sync dispatch unacknowledged'));

    const result = await executeApproveProposedRelation(
      { proposalId: 'proposal-9' },
      {
        principal: 'human',
        confirmationText: 'approve proposal proposal-9',
        userId: 'u1',
        requestId: 'a-later-turn',
      }
    );

    expect(result.success).toBe(false);
    expect(readNoMutationProof(result)).toBeUndefined();
    expect(result.error).toBe('sync dispatch unacknowledged');
  });
});

describe('executeBulkApproveHighConfidenceProposals — principal refusal proves no mutation (AI-047)', () => {
  const pending = [
    {
      id: 'proposal-1',
      confidence: 95,
      status: 'pending',
    } as unknown as ProposedRelation,
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProposedRelations.mockResolvedValue(pending);
    mockBulkApproveProposedRelations.mockResolvedValue({ approved: 1, failed: 0, errors: [] });
  });

  it('proves a machine-principal refusal approved nothing and never reads proposals', async () => {
    const result = await executeBulkApproveHighConfidenceProposals({ minConfidence: 85 }, { principal: 'machine' });

    expect(result.success).toBe(false);
    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'principal' });
    expect(result.error).toContain('human review action');
    expect(mockGetProposedRelations).not.toHaveBeenCalled();
    expect(mockBulkApproveProposedRelations).not.toHaveBeenCalled();
  });

  it('proves an empty match set approved nothing', async () => {
    mockGetProposedRelations.mockResolvedValueOnce([]);

    const result = await executeBulkApproveHighConfidenceProposals({ minConfidence: 85 }, { principal: 'human' });

    expect(result.success).toBe(true);
    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'lookup' });
    expect(mockBulkApproveProposedRelations).not.toHaveBeenCalled();
  });

  it('proves a throw while READING proposals approved nothing', async () => {
    mockGetProposedRelations.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const result = await executeBulkApproveHighConfidenceProposals({ minConfidence: 85 }, { principal: 'human' });

    expect(result.success).toBe(false);
    expect(readNoMutationProof(result)).toEqual({ mutationAttempted: false, stage: 'unexpected' });
    expect(result.error).toBe('Firestore unavailable');
  });

  it('stays conservative when the bulk approval itself throws', async () => {
    mockBulkApproveProposedRelations.mockRejectedValueOnce(new Error('partial batch failure'));

    const result = await executeBulkApproveHighConfidenceProposals({ minConfidence: 85 }, { principal: 'human' });

    expect(result.success).toBe(false);
    expect(readNoMutationProof(result)).toBeUndefined();
    expect(result.error).toBe('partial batch failure');
  });
});
