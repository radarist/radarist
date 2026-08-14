/**
 * @file linker-tools.test.ts
 * @description Tests for the proposeVerifiedRelation AI tool
 */

// Must declare mocks before imports
jest.mock('@/lib/firebase', () => ({ db: {} }));
// Source now imports the admin twins (proposed-relations-admin / relations-admin),
// not the client modules, after the client→admin SDK migration.
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
    buildEntitySnapshot: jest.fn(async (id: string, type: string) => ({
      id,
      type,
      name: `${type} ${id}`,
      snapshotAt: 100,
    })),
    DuplicateRelationError,
  };
});
jest.mock('@/lib/proposed-relations-admin', () => ({
  createProposedRelationIfNotExists: jest.fn().mockResolvedValue({
    created: true,
    proposal: {
      id: 'pr-1',
      sourceId: 'company-1',
      sourceType: 'company',
      sourceSnapshot: { id: 'company-1', type: 'company', name: 'Company 1', snapshotAt: 100 },
      targetId: 'tech-1',
      targetType: 'technology',
      targetSnapshot: { id: 'tech-1', type: 'technology', name: 'Technology 1', snapshotAt: 100 },
      relationType: 'uses',
      confidence: 70,
      reasoning: 'Assistant relation',
      evidence: [],
      status: 'pending',
      discoveredBy: 'ai-assistant',
      createdAt: 100,
      updatedAt: 100,
    },
  }),
  attachMaterializedRelationToProposal: jest.fn(async (proposalId: string, relation: { id: string }) => ({
    attached: true,
    proposal: {
      id: proposalId,
      relationId: relation.id,
      status: 'pending',
    },
  })),
  relationMatchesProposal: jest.fn(() => true),
  getProposedRelations: jest.fn().mockResolvedValue([]),
  getProposedRelationById: jest.fn().mockResolvedValue(null),
  getProposedRelationByKey: jest.fn().mockResolvedValue(null),
  approveProposedRelation: jest.fn(),
  rejectProposedRelation: jest.fn(),
  dismissProposedRelation: jest.fn(),
  bulkApproveProposedRelations: jest.fn(),
}));
// AI-039 — `createRelations` resolves name endpoints through this helper, which
// reaches the admin entity readers (and so firebase-admin) at module load. These
// suites exercise linker logic, not name resolution, so the helper is stubbed.
const mockResolveEntityEndpointByExactName = jest.fn();
jest.mock('@/lib/ai/tools/helpers/resolve-entity-endpoint', () => ({
  __esModule: true,
  resolveEntityEndpointByExactName: (...args: unknown[]) => mockResolveEntityEndpointByExactName(...args),
  describeEntityEndpointFailure: (failure: { kind: string; entityType: string; name: string }) =>
    `${failure.kind}: ${failure.entityType} "${failure.name}"`,
}));
jest.mock('@/lib/linker/relation-ontology', () => ({
  validateRelation: jest.fn().mockReturnValue({ valid: true, shouldSwap: false }),
}));
jest.mock('@/lib/linker/confidence-config', () => ({
  getConfidenceThreshold: jest.fn().mockReturnValue(75),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn(() => Promise.resolve()),
}));

// Import after mocks
import {
  executeProposeVerifiedRelation,
  executeApproveProposedRelation,
  executeListPendingProposedRelations,
  executeRejectProposedRelation,
  executeDismissProposedRelation,
  executeBulkApproveHighConfidenceProposals,
  executeCreateRelation,
  executeGetProposedRelationDetails,
  LINKER_TOOLS,
} from '../linker-tools';
import {
  createProposedRelationIfNotExists,
  approveProposedRelation,
  getProposedRelations,
  getProposedRelationById,
  getProposedRelationByKey,
  rejectProposedRelation,
  dismissProposedRelation,
  bulkApproveProposedRelations,
} from '@/lib/proposed-relations-admin';
import {
  adminCreateRelationFromIds,
  adminCheckDuplicateRelation,
  adminUpdateRelationFromFreshState,
  buildEntitySnapshot,
  DuplicateRelationError,
} from '@/lib/relations-admin';
import { validateRelation } from '@/lib/linker/relation-ontology';
import { getConfidenceThreshold } from '@/lib/linker/confidence-config';
import type { ProposedRelation } from '@/lib/types';

const mockValidateRelation = validateRelation as jest.MockedFunction<typeof validateRelation>;
const mockGetConfidenceThreshold = getConfidenceThreshold as jest.MockedFunction<typeof getConfidenceThreshold>;
const mockApproveProposedRelation = approveProposedRelation as jest.MockedFunction<typeof approveProposedRelation>;
const mockAdminCreateRelationFromIds = adminCreateRelationFromIds as jest.MockedFunction<
  typeof adminCreateRelationFromIds
>;
const mockAdminCheckDuplicateRelation = adminCheckDuplicateRelation as jest.MockedFunction<
  typeof adminCheckDuplicateRelation
>;
const mockAdminUpdateRelationFromFreshState = adminUpdateRelationFromFreshState as jest.MockedFunction<
  typeof adminUpdateRelationFromFreshState
>;
const mockBuildEntitySnapshot = buildEntitySnapshot as jest.MockedFunction<typeof buildEntitySnapshot>;
const mockCreateProposal = createProposedRelationIfNotExists as jest.MockedFunction<
  typeof createProposedRelationIfNotExists
>;
const mockGetProposedRelations = getProposedRelations as jest.MockedFunction<typeof getProposedRelations>;
const mockGetProposedRelationById = getProposedRelationById as jest.MockedFunction<typeof getProposedRelationById>;
const mockGetProposedRelationByKey = getProposedRelationByKey as jest.MockedFunction<typeof getProposedRelationByKey>;
const mockRejectProposedRelation = rejectProposedRelation as jest.MockedFunction<typeof rejectProposedRelation>;
const mockDismissProposedRelation = dismissProposedRelation as jest.MockedFunction<typeof dismissProposedRelation>;
const mockBulkApproveProposedRelations = bulkApproveProposedRelations as jest.MockedFunction<
  typeof bulkApproveProposedRelations
>;

// ============================================================================
// Shared fixtures for the ported (from src/lib/ai/__tests__/linker-tools.test.ts)
// executeListPendingProposedRelations / executeBulkApproveHighConfidenceProposals /
// executeGetProposedRelationDetails suites below.
// ============================================================================
function makeProposal(overrides: Partial<ProposedRelation> = {}): ProposedRelation {
  const now = Date.now();
  return {
    id: 'proposal-1',
    sourceId: 'company-1',
    sourceType: 'company',
    sourceSnapshot: { type: 'company', id: 'company-1', name: 'Acme Corp', snapshotAt: now },
    targetId: 'tech-1',
    targetType: 'technology',
    targetSnapshot: { type: 'technology', id: 'tech-1', name: 'React', snapshotAt: now },
    relationType: 'uses',
    confidence: 85,
    reasoning: 'Acme Corp uses React for their frontend',
    evidence: [],
    discoveredBy: 'ai-assistant',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const mockProposal = makeProposal();
const mockProposals: ProposedRelation[] = [
  mockProposal,
  makeProposal({
    id: 'proposal-2',
    sourceId: 'company-2',
    sourceSnapshot: { type: 'company', id: 'company-2', name: 'TechCo', snapshotAt: Date.now() },
    confidence: 92,
    createdAt: Date.now() - 1000,
  }),
  makeProposal({
    id: 'proposal-3',
    sourceId: 'company-3',
    sourceSnapshot: { type: 'company', id: 'company-3', name: 'StartupX', snapshotAt: Date.now() },
    confidence: 75,
    createdAt: Date.now() - 2000,
  }),
];

// ============================================================================
// Tool Definitions — ported from src/lib/ai/__tests__/linker-tools.test.ts
// (older duplicate suite, removed; these schema pins had no equivalent here).
// ============================================================================
describe('LINKER_TOOLS array', () => {
  // 9 since AI-039 added the batch writer `createRelations` (was 8).
  it('should have 9 tool definitions', () => {
    expect(LINKER_TOOLS).toHaveLength(9);
  });

  it('should have unique tool names', () => {
    const names = LINKER_TOOLS.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('should have all expected tools', () => {
    const toolNames = LINKER_TOOLS.map((t) => t.name);
    expect(toolNames).toContain('listPendingProposedRelations');
    expect(toolNames).toContain('approveProposedRelation');
    expect(toolNames).toContain('rejectProposedRelation');
    expect(toolNames).toContain('dismissProposedRelation');
    expect(toolNames).toContain('bulkApproveHighConfidenceProposals');
    expect(toolNames).toContain('createRelation');
    expect(toolNames).toContain('getProposedRelationDetails');
    expect(toolNames).toContain('proposeVerifiedRelation');
  });
});

describe('listPendingProposedRelations tool definition', () => {
  it('should have correct parameters', () => {
    const tool = LINKER_TOOLS.find((t) => t.name === 'listPendingProposedRelations');
    expect(tool).toBeDefined();
    expect(tool?.parameters?.properties).toHaveProperty('status');
    expect(tool?.parameters?.properties).toHaveProperty('sourceType');
    expect(tool?.parameters?.properties).toHaveProperty('targetType');
    expect(tool?.parameters?.properties).toHaveProperty('minConfidence');
    expect(tool?.parameters?.properties).toHaveProperty('limit');
  });

  it('should have no required parameters (all optional)', () => {
    const tool = LINKER_TOOLS.find((t) => t.name === 'listPendingProposedRelations');
    expect(tool?.parameters?.required).toBeUndefined();
  });
});

describe('approveProposedRelation tool definition', () => {
  it('should require proposalId', () => {
    const tool = LINKER_TOOLS.find((t) => t.name === 'approveProposedRelation');
    expect(tool).toBeDefined();
    expect(tool?.parameters?.properties).toHaveProperty('proposalId');
    expect(tool?.parameters?.properties).toHaveProperty('notes');
    expect(tool?.parameters?.required).toContain('proposalId');
  });
});

describe('rejectProposedRelation tool definition', () => {
  it('should require proposalId and reason', () => {
    const tool = LINKER_TOOLS.find((t) => t.name === 'rejectProposedRelation');
    expect(tool).toBeDefined();
    expect(tool?.parameters?.properties).toHaveProperty('proposalId');
    expect(tool?.parameters?.properties).toHaveProperty('reason');
    expect(tool?.parameters?.required).toContain('proposalId');
    expect(tool?.parameters?.required).toContain('reason');
  });
});

describe('dismissProposedRelation tool definition', () => {
  it('should require proposalId', () => {
    const tool = LINKER_TOOLS.find((t) => t.name === 'dismissProposedRelation');
    expect(tool).toBeDefined();
    expect(tool?.parameters?.properties).toHaveProperty('proposalId');
    expect(tool?.parameters?.required).toContain('proposalId');
  });
});

describe('bulkApproveHighConfidenceProposals tool definition', () => {
  it('should have optional parameters', () => {
    const tool = LINKER_TOOLS.find((t) => t.name === 'bulkApproveHighConfidenceProposals');
    expect(tool).toBeDefined();
    expect(tool?.parameters?.properties).toHaveProperty('minConfidence');
    expect(tool?.parameters?.properties).toHaveProperty('limit');
  });
});

describe('createRelation tool definition', () => {
  it('should have all required parameters for relation creation', () => {
    const tool = LINKER_TOOLS.find((t) => t.name === 'createRelation');
    expect(tool).toBeDefined();
    expect(tool?.parameters?.properties).toHaveProperty('sourceId');
    expect(tool?.parameters?.properties).toHaveProperty('sourceType');
    expect(tool?.parameters?.properties).toHaveProperty('targetId');
    expect(tool?.parameters?.properties).toHaveProperty('targetType');
    expect(tool?.parameters?.properties).toHaveProperty('relationType');
    expect(tool?.parameters?.properties).not.toHaveProperty('notes');
    expect(tool?.parameters?.required).toContain('sourceId');
    expect(tool?.parameters?.required).toContain('sourceType');
    expect(tool?.parameters?.required).toContain('targetId');
    expect(tool?.parameters?.required).toContain('targetType');
    expect(tool?.parameters?.required).toContain('relationType');
  });

  it('describes the explicit human-directive boundary and discovery proposal path', () => {
    const tool = LINKER_TOOLS.find((candidate) => candidate.name === 'createRelation');
    const description = tool?.description ?? '';

    expect(description).toMatch(/direct, human-curated relation/i);
    expect(description).toMatch(/current message explicitly tells you to link/i);
    expect(description).toMatch(/does not enter triage/i);
    expect(description).toMatch(/discovered or inferred candidates.*proposeVerifiedRelation/is);
    expect(description).toMatch(/server verifies the current raw user turn/i);
  });

  it.each([
    ['company', 'technology', 'uses', false],
    ['company', 'technology', 'vendor', false],
    ['company', 'company', 'partner', false],
    ['company', 'company', 'competitor', false],
    ['company', 'company', 'supplier_of', false],
    ['technology', 'useCase', 'enables', false],
    ['technology', 'useCase', 'addresses', false],
    ['initiative', 'painPoint', 'addresses', false],
    ['painPoint', 'initiative', 'drives', false],
    ['initiative', 'strategy', 'aligns_with', false],
    ['initiative', 'strategy', 'implements', false],
    ['orgUnit', 'initiative', 'sponsors', false],
    ['technology', 'company', 'uses', true],
  ] as const)(
    'keeps advertised %s -> %s %s aligned with the real ontology',
    (sourceType, targetType, relationType, shouldSwap) => {
      const actualOntology = jest.requireActual<typeof import('@/lib/linker/relation-ontology')>(
        '@/lib/linker/relation-ontology'
      );

      expect(actualOntology.validateRelation(sourceType, targetType, relationType)).toMatchObject({
        valid: true,
        shouldSwap,
      });
    }
  );
});

describe('getProposedRelationDetails tool definition', () => {
  it('should require proposalId', () => {
    const tool = LINKER_TOOLS.find((t) => t.name === 'getProposedRelationDetails');
    expect(tool).toBeDefined();
    expect(tool?.parameters?.properties).toHaveProperty('proposalId');
    expect(tool?.parameters?.required).toContain('proposalId');
  });
});

describe('executeProposeVerifiedRelation', () => {
  const validArgs = {
    sourceId: 'co-1',
    sourceType: 'company',
    targetId: 'tech-1',
    targetType: 'technology',
    relationType: 'vendor',
    confidence: 85,
    evidence: 'Found on company website as official vendor',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminCheckDuplicateRelation.mockResolvedValue(null);
    // Reset to defaults
    mockValidateRelation.mockReturnValue({ valid: true, shouldSwap: false });
    mockGetConfidenceThreshold.mockReturnValue(75);
    mockCreateProposal.mockResolvedValue({
      created: true,
      proposal: {
        id: 'pr-1',
        sourceId: 'co-1',
        sourceType: 'company',
        sourceSnapshot: { type: 'company', id: 'co-1', name: 'co-1', snapshotAt: Date.now() },
        targetId: 'tech-1',
        targetType: 'technology',
        targetSnapshot: { type: 'technology', id: 'tech-1', name: 'tech-1', snapshotAt: Date.now() },
        relationType: 'vendor',
        confidence: 85,
        reasoning: 'Found on company website as official vendor',
        evidence: [],
        status: 'pending',
        discoveredBy: 'ai-assistant',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  });

  it('should reject below-threshold confidence', async () => {
    mockGetConfidenceThreshold.mockReturnValue(75);

    const result = await executeProposeVerifiedRelation({
      ...validArgs,
      confidence: 50,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Confidence 50 is below threshold 75');
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('should create proposal for valid relation above threshold', async () => {
    const result = await executeProposeVerifiedRelation(validArgs, { requestId: 'request-17' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      proposalId: 'pr-1',
      created: true,
      reason: undefined,
    });
    expect(mockValidateRelation).toHaveBeenCalledWith('company', 'technology', 'vendor');
    expect(mockGetConfidenceThreshold).toHaveBeenCalledWith('company', 'technology');
    expect(mockCreateProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'co-1',
        sourceType: 'company',
        targetId: 'tech-1',
        targetType: 'technology',
        relationType: 'vendor',
        confidence: 85,
        discoveredBy: 'ai-assistant',
        runId: 'chat:request-17',
      })
    );
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('should reject invalid ontology relations', async () => {
    mockValidateRelation.mockReturnValue({
      valid: false,
      shouldSwap: false,
      error: "Invalid relation type 'parent' between company and technology",
      suggestions: ['vendor', 'user'],
    });

    const result = await executeProposeVerifiedRelation({
      ...validArgs,
      relationType: 'parent',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid relation type 'parent' between company and technology");
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('stores model text as reasoning without fabricating typed evidence provenance', async () => {
    await executeProposeVerifiedRelation(validArgs);

    const callArgs = mockCreateProposal.mock.calls[0][0];
    expect(callArgs.reasoning).toBe('Found on company website as official vendor');
    expect(callArgs.evidence).toEqual([]);
  });

  it('should include proper entity snapshots', async () => {
    await executeProposeVerifiedRelation(validArgs);

    const callArgs = mockCreateProposal.mock.calls[0][0];
    expect(callArgs.sourceSnapshot).toEqual(
      expect.objectContaining({
        type: 'company',
        id: 'co-1',
        name: 'company co-1',
      })
    );
    expect(callArgs.targetSnapshot).toEqual(
      expect.objectContaining({
        type: 'technology',
        id: 'tech-1',
        name: 'technology tech-1',
      })
    );
  });

  it('should handle createProposedRelationIfNotExists errors gracefully', async () => {
    mockCreateProposal.mockRejectedValue(new Error('Firestore write failed'));

    const result = await executeProposeVerifiedRelation(validArgs);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Firestore write failed');
  });

  it('should return reason when proposal already exists', async () => {
    mockCreateProposal.mockResolvedValue({
      created: false,
      proposal: {
        id: 'pr-1',
        sourceId: 'co-1',
        sourceType: 'company',
        sourceSnapshot: { type: 'company', id: 'co-1', name: 'co-1', snapshotAt: Date.now() },
        targetId: 'tech-1',
        targetType: 'technology',
        targetSnapshot: { type: 'technology', id: 'tech-1', name: 'tech-1', snapshotAt: Date.now() },
        relationType: 'vendor',
        confidence: 85,
        reasoning: 'existing',
        evidence: [],
        status: 'pending',
        discoveredBy: 'ai-assistant',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      reason: 'already_pending',
    });

    const result = await executeProposeVerifiedRelation(validArgs);

    expect(result.success).toBe(true);
    expect(result.data?.created).toBe(false);
    expect(result.data?.reason).toBe('already_pending');
  });

  it('does not create triage noise for an already curated exact triple', async () => {
    mockAdminCheckDuplicateRelation.mockResolvedValueOnce({
      id: 'relation-curated',
      aiSuggested: false,
      claimStatus: 'curated',
    } as Awaited<ReturnType<typeof adminCheckDuplicateRelation>>);

    const result = await executeProposeVerifiedRelation(validArgs);

    expect(result).toEqual({
      success: true,
      data: { dispatched: false, created: false, reason: 'already_curated' },
    });
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });
});

describe('executeApproveProposedRelation', () => {
  const approvalContext = {
    principal: 'human' as const,
    confirmationText: 'Approve pr-1.',
  };
  const approvedProposal = {
    id: 'pr-1',
    sourceId: 'co-1',
    sourceType: 'company' as const,
    sourceSnapshot: { type: 'company' as const, id: 'co-1', name: 'Acme Co', snapshotAt: Date.now() },
    targetId: 'tech-1',
    targetType: 'technology' as const,
    targetSnapshot: { type: 'technology' as const, id: 'tech-1', name: 'Kubernetes', snapshotAt: Date.now() },
    relationType: 'vendor' as const,
    confidence: 90,
    reasoning: 'test',
    evidence: [],
    status: 'approved' as const,
    relationId: 'rel-1',
    discoveredBy: 'ai-assistant' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProposedRelationById.mockResolvedValue(null);
    mockApproveProposedRelation.mockResolvedValue(approvedProposal);
  });

  it('returns the authoritative approved relation id without creating a second relation', async () => {
    const result = await executeApproveProposedRelation({ proposalId: 'pr-1' }, approvalContext);

    expect(result.success).toBe(true);
    expect(result.data?.relationId).toBe('rel-1');
    expect(mockApproveProposedRelation).toHaveBeenCalledTimes(1);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('fails loud when approval returns a corrupt proposal without a relation pointer', async () => {
    const { relationId: _relationId, ...approvedWithoutRelation } = approvedProposal;
    mockApproveProposedRelation.mockResolvedValueOnce(approvedWithoutRelation);

    const result = await executeApproveProposedRelation({ proposalId: 'pr-1' }, approvalContext);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no backing relation/i);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('approve executor: forwards context userId as feedbackUserId', async () => {
    await executeApproveProposedRelation({ proposalId: 'pr-1' }, { ...approvalContext, userId: 'u1' });

    expect(mockApproveProposedRelation).toHaveBeenCalledWith('pr-1', 'user:u1', { feedbackUserId: 'u1' });
  });

  it('approve executor: omits the options arg entirely when no context userId is given', async () => {
    await executeApproveProposedRelation({ proposalId: 'pr-1' }, approvalContext);

    expect(mockApproveProposedRelation).toHaveBeenCalledWith('pr-1', 'user:system');
  });

  // Ported from src/lib/ai/__tests__/linker-tools.test.ts ("should handle approval
  // errors"). This pins the error path where approveProposedRelation itself
  // rejects, e.g. because the proposal doesn't exist.
  it('surfaces an error thrown by approveProposedRelation itself, before relation creation is attempted', async () => {
    mockApproveProposedRelation.mockRejectedValueOnce(new Error('Proposal not found'));

    const result = await executeApproveProposedRelation(
      { proposalId: 'invalid-id' },
      { principal: 'human', confirmationText: 'Approve invalid-id.' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Proposal not found');
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('refuses a machine caller (no human principal) — approve is a gate-release action (F106)', async () => {
    // A machine dispatch carries a userId but no human principal; approve now
    // stamps claimStatus:'curated' (F105), so it must be human-only.
    const result = await executeApproveProposedRelation(
      { proposalId: 'pr-1' },
      { userId: 'apikey-user', principal: 'machine' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/human review action/i);
    expect(mockApproveProposedRelation).not.toHaveBeenCalled();
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('refuses same-turn model self-approval when the raw user turn did not name the proposal id', async () => {
    const result = await executeApproveProposedRelation(
      { proposalId: 'pr-1' },
      {
        principal: 'human',
        userId: 'u1',
        confirmationText: 'Find missing relationships around Quantum Computing.',
      }
    );

    expect(result).toMatchObject({
      success: false,
      data: { dispatched: false, proposalId: 'pr-1' },
    });
    expect(mockApproveProposedRelation).not.toHaveBeenCalled();
  });

  it('refuses approval when the proposal was created in the same request', async () => {
    mockGetProposedRelationById.mockResolvedValueOnce({
      ...approvedProposal,
      status: 'pending',
      runId: 'chat:request-17',
    });

    const result = await executeApproveProposedRelation(
      { proposalId: 'pr-1' },
      { ...approvalContext, requestId: 'request-17' }
    );

    expect(result).toMatchObject({
      success: false,
      data: { dispatched: false, proposalId: 'pr-1' },
    });
    expect(result.error).toMatch(/same Assistant turn/i);
    expect(mockApproveProposedRelation).not.toHaveBeenCalled();
  });

  it('allows exact approval from a later request', async () => {
    mockGetProposedRelationById.mockResolvedValueOnce({
      ...approvedProposal,
      status: 'pending',
      runId: 'chat:request-17',
    });

    const result = await executeApproveProposedRelation(
      { proposalId: 'pr-1' },
      { ...approvalContext, requestId: 'request-18' }
    );

    expect(result.success).toBe(true);
    expect(mockApproveProposedRelation).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// The six describe blocks below are ported wholesale from
// src/lib/ai/__tests__/linker-tools.test.ts (the older duplicate suite, now
// removed) — this file previously only covered executeProposeVerifiedRelation
// and executeApproveProposedRelation, leaving these six executors untested here.
// ============================================================================

describe('executeListPendingProposedRelations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return proposals with default filters', async () => {
    mockGetProposedRelations.mockResolvedValueOnce(mockProposals);

    const result = await executeListPendingProposedRelations({});

    expect(result.success).toBe(true);
    expect(result.data?.proposals).toHaveLength(3);
    expect(result.data?.total).toBe(3);
    expect(mockGetProposedRelations).toHaveBeenCalledWith({ status: 'pending' });
  });

  it('should filter by minConfidence', async () => {
    mockGetProposedRelations.mockResolvedValueOnce(mockProposals);

    const result = await executeListPendingProposedRelations({ minConfidence: 80 });

    expect(result.success).toBe(true);
    // Only 2 proposals have confidence >= 80 (85, 92)
    expect(result.data?.proposals).toHaveLength(2);
  });

  it('should respect limit parameter', async () => {
    mockGetProposedRelations.mockResolvedValueOnce(mockProposals);

    const result = await executeListPendingProposedRelations({ limit: 1 });

    expect(result.success).toBe(true);
    expect(result.data?.proposals).toHaveLength(1);
    expect(result.data?.total).toBe(3); // Total before limit
  });

  it('should enforce max limit of 50', async () => {
    mockGetProposedRelations.mockResolvedValueOnce(mockProposals);

    const result = await executeListPendingProposedRelations({ limit: 100 });

    expect(result.success).toBe(true);
    // Even though limit=100, it should be capped at 50
    // (but we only have 3 proposals, so we get 3)
    expect(result.data?.proposals).toHaveLength(3);
  });

  it('should sort by confidence descending', async () => {
    mockGetProposedRelations.mockResolvedValueOnce(mockProposals);

    const result = await executeListPendingProposedRelations({});

    expect(result.success).toBe(true);
    const confidences = result.data?.proposals.map((p) => p.confidence);
    expect(confidences).toEqual([92, 85, 75]); // Sorted descending
  });

  it('should handle errors gracefully, leaving data undefined', async () => {
    mockGetProposedRelations.mockRejectedValueOnce(new Error('Database error'));

    const result = await executeListPendingProposedRelations({});

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Database error');
    // Union pin from the old suite's "Error Response Format" block: data must
    // be undefined (not populated / not null) on the error path.
    expect(result.data).toBeUndefined();
  });
});

describe('executeRejectProposedRelation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject proposal with reason', async () => {
    mockRejectProposedRelation.mockResolvedValueOnce(mockProposal);

    const result = await executeRejectProposedRelation({
      proposalId: 'proposal-1',
      reason: 'Not relevant',
    });

    expect(result.success).toBe(true);
    expect(result.data?.proposalId).toBe('proposal-1');
    expect(result.data?.message).toContain('Not relevant');
    expect(mockRejectProposedRelation).toHaveBeenCalledWith('proposal-1', 'agent:linker', 'Not relevant');
  });

  it('should handle rejection errors', async () => {
    mockRejectProposedRelation.mockRejectedValueOnce(new Error('Proposal not found'));

    const result = await executeRejectProposedRelation({
      proposalId: 'invalid-id',
      reason: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Proposal not found');
  });

  // #117 — reviewer provenance is accurate, not the generic 'ai-assistant'.
  it('stamps a human reviewer as user:<uid>', async () => {
    mockRejectProposedRelation.mockResolvedValueOnce(mockProposal);

    await executeRejectProposedRelation(
      { proposalId: 'proposal-1', reason: 'Not relevant' },
      { userId: 'u1', principal: 'human' }
    );

    expect(mockRejectProposedRelation).toHaveBeenCalledWith('proposal-1', 'user:u1', 'Not relevant', {
      feedbackUserId: 'u1',
    });
  });

  it('stamps a machine reviewer as agent:linker even when it carries a userId', async () => {
    mockRejectProposedRelation.mockResolvedValueOnce(mockProposal);

    // A machine caller (external MCP write-key / mission) always carries a
    // userId (apiKey.userId), but it is NOT a human — the stamp must stay in
    // the agent domain so provenance is honest.
    await executeRejectProposedRelation(
      { proposalId: 'proposal-1', reason: 'stale' },
      { userId: 'apikey-user', principal: 'machine' }
    );

    expect(mockRejectProposedRelation).toHaveBeenCalledWith('proposal-1', 'agent:linker', 'stale', {
      feedbackUserId: 'apikey-user',
    });
  });
});

describe('executeDismissProposedRelation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should dismiss proposal permanently', async () => {
    mockDismissProposedRelation.mockResolvedValueOnce(mockProposal);

    const result = await executeDismissProposedRelation({
      proposalId: 'proposal-1',
    });

    expect(result.success).toBe(true);
    expect(result.data?.proposalId).toBe('proposal-1');
    expect(result.data?.message).toContain('dismissed');
    expect(mockDismissProposedRelation).toHaveBeenCalledWith('proposal-1', 'agent:linker');
  });

  it('should handle dismissal errors', async () => {
    mockDismissProposedRelation.mockRejectedValueOnce(new Error('Proposal not found'));

    const result = await executeDismissProposedRelation({
      proposalId: 'invalid-id',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Proposal not found');
  });
});

describe('executeBulkApproveHighConfidenceProposals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should bulk approve high confidence proposals', async () => {
    mockGetProposedRelations.mockResolvedValueOnce(mockProposals);
    mockBulkApproveProposedRelations.mockResolvedValueOnce({ approved: 2, failed: 0, errors: [] });

    const result = await executeBulkApproveHighConfidenceProposals({ minConfidence: 85 }, { principal: 'human' });

    expect(result.success).toBe(true);
    expect(result.data?.approved).toBe(2);
    expect(result.data?.failed).toBe(0);
  });

  it('should use default minConfidence of 85', async () => {
    mockGetProposedRelations.mockResolvedValueOnce(mockProposals);
    mockBulkApproveProposedRelations.mockResolvedValueOnce({ approved: 2, failed: 0, errors: [] });

    await executeBulkApproveHighConfidenceProposals({}, { principal: 'human' });

    // Should filter proposals with confidence >= 85
    expect(mockBulkApproveProposedRelations).toHaveBeenCalledWith(
      ['proposal-2', 'proposal-1'], // proposal-2 (92) and proposal-1 (85)
      'user:system'
    );
  });

  it('should return message when no proposals match threshold', async () => {
    mockGetProposedRelations.mockResolvedValueOnce([makeProposal({ confidence: 70 })]);

    const result = await executeBulkApproveHighConfidenceProposals({ minConfidence: 90 }, { principal: 'human' });

    expect(result.success).toBe(true);
    expect(result.data?.approved).toBe(0);
    expect(result.data?.message).toContain('No pending proposals');
  });

  it('should respect limit parameter', async () => {
    const manyProposals = Array.from({ length: 30 }, (_, i) => makeProposal({ id: `proposal-${i}`, confidence: 90 }));
    mockGetProposedRelations.mockResolvedValueOnce(manyProposals);
    mockBulkApproveProposedRelations.mockResolvedValueOnce({ approved: 5, failed: 0, errors: [] });

    await executeBulkApproveHighConfidenceProposals({ minConfidence: 85, limit: 5 }, { principal: 'human' });

    expect(mockBulkApproveProposedRelations).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(String)]),
      'user:system'
    );
    // Should only pass 5 proposal IDs
    const passedIds = mockBulkApproveProposedRelations.mock.calls[0][0];
    expect(passedIds).toHaveLength(5);
  });
});

describe('executeCreateRelation', () => {
  const directArgs = {
    sourceId: 'company-1',
    sourceType: 'company',
    targetId: 'tech-1',
    targetType: 'technology',
    relationType: 'custom',
  } as const;
  const directContext = {
    principal: 'human' as const,
    confirmationText: 'Link Acme Corp to Quantum Computing.',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProposedRelationByKey.mockResolvedValue(null);
    mockAdminCheckDuplicateRelation.mockResolvedValue(null);
    mockAdminUpdateRelationFromFreshState.mockImplementation(async (id, deriveUpdates) => {
      const current = {
        id,
        relationType: 'custom',
        sourceSnapshot: { id: 'company-1', type: 'company', name: 'Acme Corp', snapshotAt: 100 },
        targetSnapshot: { id: 'tech-1', type: 'technology', name: 'Quantum Computing', snapshotAt: 100 },
        confidence: 70,
        aiSuggested: true,
        claimStatus: 'proposed',
        createdAt: 100,
        updatedAt: 100,
        extractedAt: 100,
      } as const;
      const updates = deriveUpdates(current);
      return { ...current, ...(updates ?? {}) };
    });
    mockValidateRelation.mockReturnValue({ valid: true, shouldSwap: false });
    mockBuildEntitySnapshot.mockImplementation(async (id, type) => ({
      id,
      type,
      name: id === 'company-1' ? 'Acme Corp' : 'Quantum Computing',
      snapshotAt: 100,
    }));
    mockAdminCreateRelationFromIds.mockResolvedValue({ id: 'relation-1' } as Awaited<
      ReturnType<typeof adminCreateRelationFromIds>
    >);
  });

  it('rejects invalid ontology before entity reads or writes', async () => {
    mockValidateRelation.mockReturnValueOnce({
      valid: false,
      shouldSwap: false,
      error: 'Invalid relation type',
    });

    const result = await executeCreateRelation(directArgs, directContext);

    expect(result).toMatchObject({ success: false, error: 'Invalid relation type' });
    expect(mockBuildEntitySnapshot).not.toHaveBeenCalled();
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('creates one direct human-curated relation and no triage proposal for an exact user command', async () => {
    const result = await executeCreateRelation(directArgs, directContext);

    expect(result).toMatchObject({
      success: true,
      data: { dispatched: true, relationId: 'relation-1', created: true },
    });
    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledWith({
      sourceId: 'company-1',
      sourceType: 'company',
      targetId: 'tech-1',
      targetType: 'technology',
      relationType: 'custom',
      confidence: 100,
      aiSuggested: false,
      claimStatus: 'curated',
    });
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('does not persist model-authored notes as a human-curated claim', async () => {
    await executeCreateRelation({ ...directArgs, notes: 'Invented primary-provider rationale' }, directContext);

    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledWith(
      expect.not.objectContaining({ notes: expect.anything() })
    );
  });

  it('persists the ontology-canonical direction when validation requests a swap', async () => {
    mockValidateRelation.mockReturnValueOnce({ valid: true, shouldSwap: true });

    await executeCreateRelation(
      {
        ...directArgs,
        sourceId: 'tech-1',
        sourceType: 'technology',
        targetId: 'company-1',
        targetType: 'company',
      },
      directContext
    );

    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'company-1',
        sourceType: 'company',
        targetId: 'tech-1',
        targetType: 'technology',
      })
    );
  });

  it.each([
    'Connect Quantum Computing as vendor to Acme Corp.',
    'Link Quantum Computing to Acme Corp as vendor.',
    'Link Quantum Computing to Acme Corp with relation type vendor.',
  ])('refuses stronger semantics whose literal direction opposes an ontology swap: %s', async (confirmationText) => {
    mockValidateRelation.mockReturnValueOnce({ valid: true, shouldSwap: true });

    const result = await executeCreateRelation(
      {
        ...directArgs,
        sourceId: 'tech-1',
        sourceType: 'technology',
        targetId: 'company-1',
        targetType: 'company',
        relationType: 'vendor',
      },
      {
        principal: 'human',
        confirmationText,
      }
    );

    expect(result).toMatchObject({
      success: false,
      data: { dispatched: false, created: false },
    });
    expect(result.error).toMatch(/relation (?:write|predicate) was not authorized/i);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('allows a stronger predicate only when the same user turn states it', async () => {
    const result = await executeCreateRelation(
      { ...directArgs, relationType: 'uses' },
      {
        principal: 'human',
        confirmationText: 'Link Acme Corp to Quantum Computing because Acme Corp uses Quantum Computing.',
      }
    );

    expect(result.success).toBe(true);
    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledWith(expect.objectContaining({ relationType: 'uses' }));
  });

  // AI-020 — bounded canonical typed directives authorize pair AND predicate.
  it.each([
    'Create a vendor relationship between Acme Corp and Quantum Computing.',
    'Connect Acme Corp as vendor to Quantum Computing.',
  ])('creates a typed direct relation for the bounded explicit form: %s', async (confirmationText) => {
    const result = await executeCreateRelation(
      { ...directArgs, relationType: 'vendor' },
      { principal: 'human', confirmationText }
    );

    expect(result).toMatchObject({
      success: true,
      data: { dispatched: true, relationId: 'relation-1', created: true },
    });
    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({ relationType: 'vendor', claimStatus: 'curated', aiSuggested: false })
    );
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('suggests canonical resolved-entity phrasing when the pair is not authorized', async () => {
    const result = await executeCreateRelation(directArgs, {
      principal: 'human',
      confirmationText: 'What technologies does Acme Corp use?',
    });

    expect(result.success).toBe(false);
    expect(result.data?.message).toContain('"Link Acme Corp to Quantum Computing"');
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('suggests canonical typed phrasing when only the stronger predicate is unauthorized', async () => {
    const result = await executeCreateRelation({ ...directArgs, relationType: 'supplier_of' }, directContext);

    expect(result.success).toBe(false);
    expect(result.data?.message).toContain(
      '"Create a supplier of relationship between Acme Corp and Quantum Computing"'
    );
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('refuses a stronger predicate inferred by the model from a generic link request', async () => {
    const result = await executeCreateRelation({ ...directArgs, relationType: 'uses' }, directContext);

    expect(result).toMatchObject({
      success: false,
      data: { dispatched: false, created: false },
    });
    expect(result.error).toMatch(/predicate was not authorized/i);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it.each([
    [{ principal: 'machine' as const, confirmationText: 'Link Acme Corp to Quantum Computing.' }, 'machine caller'],
    [
      { principal: 'human' as const, confirmationText: 'Find missing links between Acme Corp and Quantum Computing.' },
      'discovery request',
    ],
    [
      { principal: 'human' as const, confirmationText: 'Link Acme Corp to a useful technology.' },
      'missing exact target',
    ],
  ])('refuses %s before any relation or proposal write', async (context, _caseName) => {
    const result = await executeCreateRelation(directArgs, context);

    expect(result).toMatchObject({
      success: false,
      data: { dispatched: false, created: false },
    });
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('treats an exact duplicate as idempotent success', async () => {
    mockAdminCreateRelationFromIds.mockRejectedValueOnce(
      new DuplicateRelationError({ id: 'relation-existing' } as Awaited<ReturnType<typeof adminCreateRelationFromIds>>)
    );

    const result = await executeCreateRelation(directArgs, directContext);

    expect(result).toMatchObject({
      success: true,
      data: {
        dispatched: true,
        relationId: 'relation-existing',
        created: false,
      },
    });
    expect(mockCreateProposal).not.toHaveBeenCalled();
    expect(mockAdminUpdateRelationFromFreshState).toHaveBeenCalledWith('relation-existing', expect.any(Function));
  });

  it('curates an existing duplicate instead of reporting it as newly created', async () => {
    mockAdminCheckDuplicateRelation.mockResolvedValueOnce({
      id: 'relation-existing',
      claimStatus: 'proposed',
    } as Awaited<ReturnType<typeof adminCheckDuplicateRelation>>);

    const result = await executeCreateRelation(directArgs, directContext);

    expect(result).toMatchObject({
      success: true,
      data: { relationId: 'relation-existing', created: false },
    });
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(mockAdminUpdateRelationFromFreshState).toHaveBeenCalledTimes(1);
  });

  it('resolves an existing pending proposal through the explicit human directive', async () => {
    mockGetProposedRelationByKey.mockResolvedValueOnce({
      ...makeProposal({ id: 'proposal-existing', relationType: 'custom' }),
      sourceId: 'company-1',
      sourceType: 'company',
      targetId: 'tech-1',
      targetType: 'technology',
    });
    mockApproveProposedRelation.mockResolvedValueOnce({
      ...makeProposal({ id: 'proposal-existing', relationType: 'custom' }),
      status: 'approved',
      relationId: 'relation-existing',
    });

    const result = await executeCreateRelation(directArgs, {
      ...directContext,
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      success: true,
      data: { relationId: 'relation-existing', created: false },
    });
    expect(mockApproveProposedRelation).toHaveBeenCalledWith('proposal-existing', 'user:user-1', {
      feedbackUserId: 'user-1',
    });
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('fails loud on a non-duplicate relation write error', async () => {
    mockAdminCreateRelationFromIds.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const result = await executeCreateRelation(directArgs, directContext);

    expect(result).toMatchObject({ success: false, error: 'Firestore unavailable' });
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });
});
describe('executeGetProposedRelationDetails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return proposal details', async () => {
    mockGetProposedRelations.mockResolvedValueOnce([mockProposal]);

    const result = await executeGetProposedRelationDetails({
      proposalId: 'proposal-1',
    });

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('proposal-1');
    expect(result.data?.sourceSnapshot.name).toBe('Acme Corp');
  });

  it('should return error when proposal not found', async () => {
    mockGetProposedRelations.mockResolvedValueOnce([]);

    const result = await executeGetProposedRelationDetails({
      proposalId: 'nonexistent',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('executeProposeVerifiedRelation — interactive discovery boundary', () => {
  const discoveryArgs = {
    sourceId: 'co-1',
    sourceType: 'company',
    targetId: 'tech-1',
    targetType: 'technology',
    relationType: 'vendor',
    confidence: 90,
    evidence: 'Found on company website as official vendor',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateRelation.mockReturnValue({ valid: true, shouldSwap: false });
    mockGetConfidenceThreshold.mockReturnValue(75);
    mockBuildEntitySnapshot.mockImplementation(async (id, type) => ({
      id,
      type,
      name: id === 'co-1' ? 'Acme Corp' : 'Quantum Computing',
      snapshotAt: 100,
    }));
    mockCreateProposal.mockResolvedValue({
      created: true,
      proposal: makeProposal({ id: 'proposal-discovery-1', confidence: 90 }),
    });
  });

  it('never auto-applies an Assistant discovery even when linker autopilot env flags are enabled', async () => {
    const originalEnabled = process.env.LINKER_AUTOPILOT_ENABLED;
    const originalThreshold = process.env.LINKER_AUTO_APPROVE_THRESHOLD;
    process.env.LINKER_AUTOPILOT_ENABLED = 'true';
    process.env.LINKER_AUTO_APPROVE_THRESHOLD = '75';

    try {
      const result = await executeProposeVerifiedRelation(discoveryArgs);

      expect(result).toMatchObject({
        success: true,
        data: { proposalId: 'proposal-discovery-1', created: true },
      });
      expect(mockCreateProposal).toHaveBeenCalledTimes(1);
      expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    } finally {
      if (originalEnabled === undefined) delete process.env.LINKER_AUTOPILOT_ENABLED;
      else process.env.LINKER_AUTOPILOT_ENABLED = originalEnabled;
      if (originalThreshold === undefined) delete process.env.LINKER_AUTO_APPROVE_THRESHOLD;
      else process.env.LINKER_AUTO_APPROVE_THRESHOLD = originalThreshold;
    }
  });

  it('stores ontology-canonical endpoints with authoritative entity names', async () => {
    mockValidateRelation.mockReturnValueOnce({ valid: true, shouldSwap: true });

    await executeProposeVerifiedRelation({
      ...discoveryArgs,
      sourceId: 'tech-1',
      sourceType: 'technology',
      targetId: 'co-1',
      targetType: 'company',
    });

    expect(mockCreateProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'co-1',
        sourceType: 'company',
        sourceSnapshot: expect.objectContaining({ name: 'Acme Corp' }),
        targetId: 'tech-1',
        targetType: 'technology',
        targetSnapshot: expect.objectContaining({ name: 'Quantum Computing' }),
      })
    );
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
  });
});
