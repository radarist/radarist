/**
 * GRAPH-070 — unresolved Google grounding redirects must never enter durable
 * evidence as a citable source.
 *
 * A redirect URL proves a page was consulted, not which publisher supported the
 * claim. Two redirects may alias one article, so accepting them as evidence
 * identities lets a single source masquerade as corroboration and inflates the
 * derived `effectiveConfidence` the B0/C3 contract builds on that count.
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
import { executeCreateRelationWithEvidence } from '../assertions-tools';

const mockedCreate = relationsAdmin.adminCreateRelationFromIds as jest.Mock;

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQabc123';

function baseArgs(evidence: Record<string, unknown>) {
  return {
    sourceType: 'company',
    sourceId: 'c1',
    targetType: 'technology',
    targetId: 't1',
    relationType: 'uses',
    confidence: 80,
    evidence,
  };
}

describe('executeCreateRelationWithEvidence — grounding redirect refusal (GRAPH-070)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreate.mockResolvedValue({ id: 'rel-new' });
  });

  it('refuses evidence whose sourceUrl is an unresolved grounding redirect', async () => {
    const result = await executeCreateRelationWithEvidence(baseArgs({ snippet: 'x', sourceUrl: REDIRECT }));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/publisher URL/i);
  });

  it('writes nothing durable when the redirect is refused', async () => {
    await executeCreateRelationWithEvidence(baseArgs({ snippet: 'x', sourceUrl: REDIRECT }));

    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('refuses a sourceUrl that is not a usable http(s) URL', async () => {
    const result = await executeCreateRelationWithEvidence(baseArgs({ snippet: 'x', sourceUrl: 'not-a-url' }));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/http\(s\) URL/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('refuses a redirect regardless of case and tracking-parameter noise', async () => {
    const result = await executeCreateRelationWithEvidence(
      baseArgs({
        snippet: 'x',
        sourceUrl: 'https://VertexAISearch.cloud.google.com/grounding-api-redirect/AUZIYQ?utm_source=chat',
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/publisher URL/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('accepts a real publisher URL and still writes the relation', async () => {
    const result = await executeCreateRelationWithEvidence(
      baseArgs({ snippet: 'x', sourceUrl: 'https://publisher.com/article' })
    );

    expect(result.success).toBe(true);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const input = mockedCreate.mock.calls[0][0] as { evidenceRefs: Array<{ url?: string }> };
    expect(input.evidenceRefs[0].url).toBe('https://publisher.com/article');
  });

  it('accepts evidence with no sourceUrl at all (document/signal citations)', async () => {
    const result = await executeCreateRelationWithEvidence(baseArgs({ snippet: 'x', documentId: 'doc-1' }));

    expect(result.success).toBe(true);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it('tells the model, in the tool declaration, not to send redirect URLs', async () => {
    const { ASSERTIONS_TOOLS } = await import('../assertions-tools');
    const declaration = ASSERTIONS_TOOLS.find((t) => t.name === 'createRelationWithEvidence');
    const sourceUrl = (
      declaration?.parameters?.properties?.evidence as { properties?: { sourceUrl?: { description?: string } } }
    )?.properties?.sourceUrl;

    expect(sourceUrl?.description).toMatch(/publisher/i);
    expect(sourceUrl?.description).toMatch(/redirect/i);
  });
});
