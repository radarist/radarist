/**
 * @file business-queries-confidence.test.ts
 * @description GRAPH-057: every business score must prefer the system's
 * effective confidence while preserving zero and bounding malformed legacy
 * graph properties.
 *
 * @jest-environment node
 */

const mockFindConnected = jest.fn();
const mockFindPath = jest.fn();
const mockGetNeighbors = jest.fn();
const mockGetEntity = jest.fn();

const NODE = {
  id: 'node-1',
  labels: ['Technology'],
  properties: { name: 'Node 1' },
};

const mockService = {
  getNode: jest.fn(async () => NODE),
};

jest.mock('../traversal', () => ({
  findConnected: (...args: unknown[]) => mockFindConnected(...args),
  findPath: (...args: unknown[]) => mockFindPath(...args),
  getNeighbors: (...args: unknown[]) => mockGetNeighbors(...args),
  // AI-026: business queries resolve an id through `getEntity`, whose identity
  // guard is what keeps an `:AgentObservation` id from being reported as the
  // technology under analysis.
  getEntity: (...args: unknown[]) => mockGetEntity(...args),
}));

jest.mock('../service-factory', () => ({
  getGraphService: jest.fn(async () => mockService),
}));

import {
  findSolutionsForPainPoint,
  findTechnologiesForStrategy,
  generateTechnologySummary,
  resolveBusinessRelationConfidence,
} from '../business-queries';

function pathWith(properties: Record<string, unknown>) {
  return {
    nodes: [NODE, { ...NODE, id: 'node-2' }],
    relations: [
      {
        id: 'rel-1',
        type: 'ALIGNS_WITH',
        sourceId: 'node-1',
        targetId: 'node-2',
        properties,
      },
    ],
    length: 1,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetNeighbors.mockResolvedValue([]);
  mockGetEntity.mockResolvedValue(NODE);
  mockFindConnected.mockImplementation(async (_id: string, entityType: string) => {
    if (['technology', 'strategy', 'pain_point'].includes(entityType)) {
      return [{ ...NODE, id: `${entityType}-1` }];
    }
    return [];
  });
});

describe('resolveBusinessRelationConfidence', () => {
  it.each([
    [{ effectiveConfidence: 25, confidence: 90 }, 25, 'effective confidence'],
    [{ effectiveConfidence: 0, confidence: 90 }, 0, 'explicit effective zero'],
    [{ confidence: 0 }, 0, 'explicit legacy zero'],
    [{ confidence: 65 }, 65, 'legacy confidence'],
    [{}, 80, 'missing legacy default'],
    [{ effectiveConfidence: Number.NaN, confidence: 40 }, 40, 'malformed effective fallback'],
    [{ effectiveConfidence: '90', confidence: null }, 80, 'non-numeric values'],
    [{ effectiveConfidence: -10, confidence: 50 }, 0, 'lower bound'],
    [{ effectiveConfidence: 130, confidence: 50 }, 100, 'upper bound'],
  ])('resolves %s to %d (%s)', (properties, expected, _description) => {
    expect(resolveBusinessRelationConfidence(properties)).toBe(expected);
  });
});

describe('business-query score consumers', () => {
  it('uses effective confidence in pain-point solution scoring', async () => {
    mockFindPath.mockResolvedValue(
      pathWith({
        assertedConfidence: 90,
        confidence: 90,
        feedbackDelta: -65,
        effectiveConfidence: 25,
      })
    );

    const [result] = await findSolutionsForPainPoint('pain-1');

    expect(result.effectivenessScore).toBe(25);
  });

  it('uses effective confidence in strategy alignment scoring', async () => {
    mockFindPath.mockResolvedValue(
      pathWith({
        assertedConfidence: 90,
        confidence: 90,
        feedbackDelta: -65,
        effectiveConfidence: 25,
      })
    );

    const [result] = await findTechnologiesForStrategy('strategy-1');

    expect(result.alignmentScore).toBe(25);
  });

  it('uses effective confidence for both technology-summary score families', async () => {
    mockFindPath.mockResolvedValue(
      pathWith({
        assertedConfidence: 40,
        confidence: 40,
        corroborationBonus: 25,
        effectiveConfidence: 65,
      })
    );

    const result = await generateTechnologySummary('tech-1');

    expect(result.alignedStrategies).toHaveLength(1);
    expect(result.alignedStrategies[0].score).toBe(65);
    expect(result.solvesPainPoints).toHaveLength(1);
    expect(result.solvesPainPoints[0].effectiveness).toBe(65);
  });

  it('keeps explicit zero through every scoring family', async () => {
    mockFindPath.mockResolvedValue(pathWith({ confidence: 90, effectiveConfidence: 0 }));

    const [solution] = await findSolutionsForPainPoint('pain-1');
    const [alignment] = await findTechnologiesForStrategy('strategy-1');
    const summary = await generateTechnologySummary('tech-1');

    expect(solution.effectivenessScore).toBe(0);
    expect(alignment.alignmentScore).toBe(0);
    expect(summary.alignedStrategies[0].score).toBe(0);
    expect(summary.solvesPainPoints[0].effectiveness).toBe(0);
  });
});
