/**
 * Contract tests for the entity-type vocabulary exposed by assertion tools.
 *
 * The model-facing declaration and the executor must agree exactly. Legacy
 * snake-case values are accepted only at the executor ingress and normalized
 * before a read or write reaches the domain services.
 */

jest.mock('@/lib/relations-admin', () => ({
  adminGetRelationById: jest.fn(),
  adminCreateRelationFromIds: jest.fn(),
  adminUpdateRelation: jest.fn(),
}));
jest.mock('@/lib/graph', () => ({
  explainConnection: jest.fn(),
  getAssertionsForEntity: jest.fn(),
  getAssertionWithEvidence: jest.fn(),
  getAssertionWithEvidenceByRelationId: jest.fn(),
}));
jest.mock('@/lib/inngest/client', () => ({ sendEvent: jest.fn() }));

import { adminCreateRelationFromIds } from '@/lib/relations-admin';
import { getAssertionsForEntity } from '@/lib/graph';
import {
  ASSERTIONS_TOOLS,
  executeCreateRelationWithEvidence,
  executeGetEntityAssertions,
} from '../assertions-tools';

const CANONICAL_ENTITY_TYPES = [
  'technology',
  'company',
  'useCase',
  'prototype',
  'strategy',
  'signal',
  'orgUnit',
  'initiative',
  'painPoint',
] as const;

type StringParameter = { enum?: string[]; description?: string };

function parameter(toolName: string, parameterName: string): StringParameter {
  const tool = ASSERTIONS_TOOLS.find((candidate) => candidate.name === toolName);
  expect(tool).toBeDefined();
  return tool?.parameters?.properties?.[parameterName] as StringParameter;
}

const mockedCreateRelation = adminCreateRelationFromIds as jest.Mock;
const mockedGetAssertions = getAssertionsForEntity as jest.Mock;

describe('assertion entity-type contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreateRelation.mockResolvedValue({ id: 'relation-1' });
    mockedGetAssertions.mockResolvedValue({ asSubject: [], asObject: [] });
  });

  it('advertises only canonical entity types accepted by both assertion executors', () => {
    expect(parameter('createRelationWithEvidence', 'sourceType').enum).toEqual(CANONICAL_ENTITY_TYPES);
    expect(parameter('createRelationWithEvidence', 'targetType').enum).toEqual(CANONICAL_ENTITY_TYPES);
    expect(parameter('getEntityAssertions', 'entityType').enum).toEqual(CANONICAL_ENTITY_TYPES);
  });

  it.each(CANONICAL_ENTITY_TYPES)('passes advertised type %s unchanged to the write executor', async (entityType) => {
    const result = await executeCreateRelationWithEvidence({
      sourceType: entityType,
      sourceId: 'source-1',
      targetType: entityType,
      targetId: 'target-1',
      relationType: 'uses',
    });

    expect(result.success).toBe(true);
    expect(mockedCreateRelation).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceType: entityType, targetType: entityType })
    );
  });

  it.each([
    ['org_unit', 'orgUnit'],
    ['pain_point', 'painPoint'],
    [' org_unit ', 'orgUnit'],
    [' pain_point ', 'painPoint'],
  ])('normalizes the bounded legacy alias %s to %s at write ingress', async (legacyType, canonicalType) => {
    const result = await executeCreateRelationWithEvidence({
      sourceType: legacyType,
      sourceId: 'source-1',
      targetType: legacyType,
      targetId: 'target-1',
      relationType: 'uses',
    });

    expect(result.success).toBe(true);
    expect(mockedCreateRelation).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceType: canonicalType, targetType: canonicalType })
    );
  });

  it.each(['OrgUnit', 'ORG_UNIT', 'pain-point', 'document', 'radarPlacement', 'unknown', 42])(
    'rejects unsupported source type %p before writing',
    async (sourceType) => {
      const result = await executeCreateRelationWithEvidence({
        sourceType,
        sourceId: 'source-1',
        targetType: 'technology',
        targetId: 'target-1',
        relationType: 'uses',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unknown sourceType/i);
      expect(mockedCreateRelation).not.toHaveBeenCalled();
    }
  );

  it('rejects an unsupported target type before writing', async () => {
    const result = await executeCreateRelationWithEvidence({
      sourceType: 'technology',
      sourceId: 'source-1',
      targetType: 'Expanded',
      targetId: 'target-1',
      relationType: 'uses',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown targetType/i);
    expect(mockedCreateRelation).not.toHaveBeenCalled();
  });

  it('normalizes legacy aliases on reads and rejects unknown values before graph access', async () => {
    const accepted = await executeGetEntityAssertions({ entityId: 'org-1', entityType: ' org_unit ' });
    expect(accepted.success).toBe(true);
    expect(mockedGetAssertions).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    const rejected = await executeGetEntityAssertions({ entityId: 'org-1', entityType: 'ORG_UNIT' });
    expect(rejected.success).toBe(false);
    expect(rejected.error).toMatch(/unknown entityType/i);
    expect(mockedGetAssertions).not.toHaveBeenCalled();
  });
});
