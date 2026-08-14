/**
 * @file tool-summaries.test.ts
 * @description Unit tests for summarizeToolCall — the single shared source of
 * per-tool summary wording used by both the AIMessage chips and the chat
 * route's no-text fallback. Moved here from AIMessage.test.tsx when the two
 * duplicate switches were consolidated.
 */

import { summarizeToolCall } from '../tool-summaries';

describe('summarizeToolCall', () => {
  it('returns an empty string when there is no result', () => {
    expect(summarizeToolCall('searchEntities', undefined, undefined)).toBe('');
  });

  it('returns the error text for failed calls', () => {
    expect(summarizeToolCall('webSearch', undefined, { success: false, error: 'timeout' })).toBe('timeout');
  });

  it('returns a generic failure label when no error text is present', () => {
    expect(summarizeToolCall('webSearch', undefined, { success: false })).toBe('Failed');
  });

  it('counts array data for searchEntities', () => {
    expect(summarizeToolCall('searchEntities', { entityType: 'technologies' }, { success: true, data: [1, 2] })).toBe(
      'Found 2 technologies'
    );
  });

  it('counts nested results for searchEntities object payloads', () => {
    expect(summarizeToolCall('searchEntities', undefined, { success: true, data: { results: [1, 2, 3, 4] } })).toBe(
      'Found 4 entities'
    );
  });

  it('uses the created entity name for createCompany', () => {
    expect(summarizeToolCall('createCompany', undefined, { success: true, data: { name: 'Acme Corp' } })).toBe(
      'Created company: Acme Corp'
    );
  });

  it('confirms a saved diagram lands in Infographics (uses the title)', () => {
    expect(summarizeToolCall('saveDiagram', { title: 'HQ Distribution' }, { success: true })).toBe(
      'Saved “HQ Distribution” to Infographics'
    );
  });

  it('falls back to a generic label when saveDiagram has no title', () => {
    expect(summarizeToolCall('saveDiagram', {}, { success: true })).toBe('Saved diagram to Infographics');
  });

  it('falls back to a placeholder when the created entity has no name', () => {
    expect(summarizeToolCall('createTechnology', undefined, { success: true, data: {} })).toBe(
      'Created technology: new technology'
    );
  });

  it('uses the title for createUseCase', () => {
    expect(summarizeToolCall('createUseCase', undefined, { success: true, data: { title: 'Fraud detection' } })).toBe(
      'Created use case: Fraud detection'
    );
  });

  it('labels an explicit direct relation as created', () => {
    expect(
      summarizeToolCall('createRelation', undefined, {
        success: true,
        data: { dispatched: true, relationId: 'rel-1', created: true },
      })
    ).toBe('Created relationship');
  });

  it('does not claim creation when the direct-write authority gate refuses', () => {
    expect(
      summarizeToolCall('createRelation', undefined, {
        success: false,
        data: { dispatched: false, created: false },
      })
    ).toBe('Relationship not created');
  });

  it('labels an idempotent direct duplicate honestly', () => {
    expect(
      summarizeToolCall('createRelation', undefined, {
        success: true,
        data: { dispatched: true, relationId: 'rel-1', created: false },
      })
    ).toBe('Relationship already exists');
  });

  it('labels AI-discovered relation candidates as proposals', () => {
    expect(
      summarizeToolCall('proposeVerifiedRelation', undefined, {
        success: true,
        data: { proposalId: 'proposal-1', created: true },
      })
    ).toBe('Proposed relationship for review');
  });

  it('labels an already-curated triple without claiming a new proposal', () => {
    expect(
      summarizeToolCall('proposeVerifiedRelation', undefined, {
        success: true,
        data: { dispatched: false, reason: 'already_curated' },
      })
    ).toBe('Relationship already curated; no proposal created');
  });

  it('reports limited results when webSearch flags searchFailed', () => {
    expect(summarizeToolCall('webSearch', undefined, { success: true, data: { searchFailed: true } })).toBe(
      'Research completed with limited results'
    );
  });

  // Reconciled wordings (the five client/server divergences — client phrasing wins)
  it('uses the short "Research completed" wording for successful webSearch', () => {
    expect(summarizeToolCall('webSearch', undefined, { success: true, data: {} })).toBe('Research completed');
  });

  it('uses the short pending wording for researchTechnologyComprehensive', () => {
    expect(
      summarizeToolCall('researchTechnologyComprehensive', undefined, {
        success: true,
        data: { status: 'pending', technologyName: 'WebGPU' },
      })
    ).toBe('Started research for WebGPU');
  });

  it('counts documents for listDocuments (no "in the library" suffix)', () => {
    expect(summarizeToolCall('listDocuments', undefined, { success: true, data: { count: 7 } })).toBe(
      'Found 7 documents'
    );
  });

  it('counts the actual results payload for searchDecoupledTechnologies', () => {
    expect(
      summarizeToolCall('searchDecoupledTechnologies', undefined, {
        success: true,
        data: { count: 3, results: [{}, {}, {}] },
      })
    ).toBe('Found 3 technologies');
  });

  // The shared normalizer lifts sibling payloads into `data`, so the summary
  // can read them instead of falling through to "Completed". These pin the
  // UI-consumption contract.
  it('summarizes compareCompetitors from its lifted comparison payload', () => {
    expect(
      summarizeToolCall('compareCompetitors', undefined, {
        success: true,
        data: { comparison: { unique: [{}, {}, {}], shared: [], gaps: [] } },
      })
    ).toBe('Compared 3 unique technologies');
  });

  it('summarizes compareCompetitors generically when the payload is empty', () => {
    expect(
      summarizeToolCall('compareCompetitors', undefined, {
        success: true,
        data: { comparison: { unique: [], shared: [], gaps: [] } },
      })
    ).toBe('Compared competitor portfolios');
  });

  it('summarizes recommendTechInvestments from its lifted recommendations payload', () => {
    expect(
      summarizeToolCall('recommendTechInvestments', undefined, {
        success: true,
        data: { recommendations: [{}, {}] },
      })
    ).toBe('Recommended 2 technologies');
  });

  it('summarizes generateVisualization from its lifted visualization identity', () => {
    expect(
      summarizeToolCall('generateVisualization', undefined, {
        success: true,
        data: { visualizationId: 'viz-1', imageUrl: 'https://x/y.png', url: '/infographics/viz-1' },
      })
    ).toBe('Saved visualization to Infographics');
  });

  it('falls back to array count for unknown tools', () => {
    expect(summarizeToolCall('someUnknownTool', undefined, { success: true, data: [1, 2, 3] })).toBe(
      'Returned 3 results'
    );
  });

  it('falls back to the entity name for unknown tools with a name field', () => {
    expect(summarizeToolCall('someUnknownTool', undefined, { success: true, data: { name: 'Widget' } })).toBe('Widget');
  });

  it('falls back to a generic label for unknown tools with opaque data', () => {
    expect(summarizeToolCall('someUnknownTool', undefined, { success: true, data: { foo: 'bar' } })).toBe('Completed');
  });
});
