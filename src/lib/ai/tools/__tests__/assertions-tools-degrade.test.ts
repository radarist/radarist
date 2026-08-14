/**
 * Honest-degrade regression — `getEntityAssertions` must NOT report a graph
 * outage as "no assertions". Before this test the inner catch returned
 * `{ success: true, claims: [] }` when Neo4j was unavailable, so a graph
 * outage was indistinguishable from a genuinely un-asserted entity (a silent
 * failure the AI assistant would render as fact). Contrast with
 * `findEntitiesByMeaning`, which signals `degraded: true`.
 *
 * @jest-environment node
 */

const mockGetAssertionsForEntity = jest.fn();

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/relations-admin', () => ({
  adminCreateRelationFromIds: jest.fn(),
  adminGetRelationById: jest.fn(),
  adminUpdateRelation: jest.fn(),
}));
jest.mock('@/lib/inngest/client', () => ({ sendEvent: jest.fn() }));
jest.mock('@/lib/graph', () => ({
  __esModule: true,
  getAssertionsForEntity: (...args: unknown[]) => mockGetAssertionsForEntity(...args),
  explainConnection: jest.fn(),
  getAssertionWithEvidence: jest.fn(),
  getAssertionWithEvidenceByRelationId: jest.fn(),
}));

import { executeGetEntityAssertions } from '../assertions-tools';

describe('executeGetEntityAssertions — honest degrade', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns real claims on success', async () => {
    mockGetAssertionsForEntity.mockResolvedValue({
      asSubject: [
        {
          id: 'rel-1',
          objectId: 'o1',
          objectName: 'Object One',
          objectType: 'technology',
          predicate: 'uses',
          confidence: 80,
          status: 'curated',
        },
      ],
      asObject: [],
    });

    const result = await executeGetEntityAssertions({ entityId: 'e1', entityType: 'technology' });

    expect(result.success).toBe(true);
    expect(result.claims).toHaveLength(1);
  });

  it('signals failure (not success+empty) when the assertion graph is unavailable', async () => {
    mockGetAssertionsForEntity.mockRejectedValue(new Error('Neo4j unavailable'));

    const result = await executeGetEntityAssertions({ entityId: 'e1', entityType: 'technology' });

    // A graph outage must NOT masquerade as "this entity has no assertions".
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
