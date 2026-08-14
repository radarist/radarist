/**
 * Contract coverage for the Linker profile's two intentionally different
 * relation representations:
 * - mission-output bundles use local 0-1 analytical confidence;
 * - proposeVerifiedRelation MCP writes use canonical predicates and 0-100.
 */

import fs from 'node:fs';
import path from 'node:path';

jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('@/lib/relations-admin', () => {
  class DuplicateRelationError extends Error {
    existingRelation: { id: string };

    constructor(existingRelation: { id: string }) {
      super('duplicate relation');
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
  createProposedRelationIfNotExists: jest.fn(async (input: Record<string, unknown>) => ({
    created: true,
    proposal: { id: 'proposal-contract-1', ...input },
  })),
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
  emitAgentEvent: jest.fn().mockResolvedValue(undefined),
}));

import { RELATION_TYPES_LOWER } from '@/lib/graph/relation-registry';
import { convertGeminiToolToMcpTool } from '@/lib/mcp/schema-converter';
import { createProposedRelationIfNotExists } from '@/lib/proposed-relations-admin';
import { executeProposeVerifiedRelation, LINKER_TOOLS } from '../linker-tools';

const mockCreateProposal = createProposedRelationIfNotExists as jest.MockedFunction<
  typeof createProposedRelationIfNotExists
>;

const profilePath = path.join(process.cwd(), 'agent/agents/linker/PROFILE.md');

function readProfile(): string {
  return fs.readFileSync(profilePath, 'utf8');
}

describe('Linker profile relation-write contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('syncs the MCP predicate block and tool enum to the canonical registry', () => {
    const profile = readProfile();
    const block = profile.match(
      /<!-- BEGIN SYNC-CHECKED: LINKER MCP RELATION TYPES -->\s*([\s\S]*?)\s*<!-- END SYNC-CHECKED: LINKER MCP RELATION TYPES -->/
    );
    const proposalDeclaration = LINKER_TOOLS.find((tool) => tool.name === 'proposeVerifiedRelation');
    const createDeclaration = LINKER_TOOLS.find((tool) => tool.name === 'createRelation');
    const proposalMcpTool = convertGeminiToolToMcpTool(proposalDeclaration!);
    const createMcpTool = convertGeminiToolToMcpTool(createDeclaration!);

    expect(block?.[1].trim()).toBe(RELATION_TYPES_LOWER.map((type) => `\`${type}\``).join(', '));
    expect(proposalMcpTool.inputSchema.properties?.relationType?.enum).toEqual([...RELATION_TYPES_LOWER]);
    expect(createMcpTool.inputSchema.properties?.relationType?.enum).toEqual([...RELATION_TYPES_LOWER]);
  });

  it('keeps local bundle confidence distinct from MCP write confidence', () => {
    const profile = readProfile();
    const declaration = LINKER_TOOLS.find((tool) => tool.name === 'proposeVerifiedRelation');
    const mcpTool = convertGeminiToolToMcpTool(declaration!);

    expect(profile).toMatch(/local mission-output bundle[\s\S]*confidence[\s\S]*0.?1/i);
    expect(profile).toMatch(/MCP relation write[\s\S]*integer[\s\S]*0.?100/i);
    expect(profile).toContain('"relationType": "competes_with"');
    expect(profile).toContain('"confidence": 0.85');
    expect(profile).toContain('"confidence": 85');
    expect(profile).not.toContain('competes-with');
    expect(mcpTool.inputSchema.properties?.confidence).toMatchObject({ type: 'integer' });
  });

  it('accepts canonical competes_with with 85 through the real ontology and threshold', async () => {
    const result = await executeProposeVerifiedRelation({
      sourceId: 'tech-a',
      sourceType: 'technology',
      targetId: 'tech-b',
      targetType: 'technology',
      relationType: 'competes_with',
      confidence: 85,
      evidence: 'technology tech-a and technology tech-b compete in the same market',
    });

    expect(result).toMatchObject({
      success: true,
      data: { proposalId: 'proposal-contract-1', created: true },
    });
    expect(mockCreateProposal).toHaveBeenCalledWith(
      expect.objectContaining({ relationType: 'competes_with', confidence: 85 })
    );
  });

  it('rejects a hyphenated predicate with its canonical snake_case replacement', async () => {
    const result = await executeProposeVerifiedRelation({
      sourceId: 'tech-a',
      sourceType: 'technology',
      targetId: 'tech-b',
      targetType: 'technology',
      relationType: 'competes-with',
      confidence: 85,
      evidence: 'technology tech-a and technology tech-b compete in the same market',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lowercase snake_case/i);
    expect(result.error).toContain('competes_with');
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('rejects 0.85 at the MCP boundary with explicit 0-100 conversion guidance', async () => {
    const result = await executeProposeVerifiedRelation({
      sourceId: 'tech-a',
      sourceType: 'technology',
      targetId: 'tech-b',
      targetType: 'technology',
      relationType: 'competes_with',
      confidence: 0.85,
      evidence: 'technology tech-a and technology tech-b compete in the same market',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/MCP relation writes require an integer from 0 to 100/i);
    expect(result.error).toMatch(/use 85 instead of 0\.85/i);
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });
});
