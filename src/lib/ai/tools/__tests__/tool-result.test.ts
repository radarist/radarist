/**
 * Contract matrix for `normalizeToolResult` (AI-011 / AI-041).
 *
 * The normalizer is the shared boundary that lifts sibling payload keys into
 * the canonical `data` slot. This matrix pins every contract case:
 *  - passthrough (unregistered, already-conforming, error envelopes)
 *  - per-tool sibling-key lifting (comparison / recommendations / vendors /
 *    summary / visualization identity)
 *  - preservation of the original top-level keys (no payload discarded)
 *  - read-only tools are never reinterpreted as mutations
 *  - generateVisualization surfaces the persisted Firestore identity while the
 *    storage object identity stays internal
 *
 * @jest-environment node
 */

import { normalizeToolResult, type ToolResult } from '../tool-result';

describe('normalizeToolResult()', () => {
  // ==========================================================================
  // Passthrough / no-op
  // ==========================================================================

  describe('passthrough', () => {
    it('returns the result unchanged for an unregistered tool', () => {
      const result: ToolResult = { success: true, data: { name: 'Acme' } };
      expect(normalizeToolResult('searchEntities', result)).toBe(result);
    });

    it('returns the result unchanged when data is already set', () => {
      const result = { success: true, comparison: { x: 1 }, data: { preexisting: true } };
      // Already conforming — the normalizer must not overwrite a prior `data`.
      const normalized = normalizeToolResult('compareCompetitors', result as unknown as ToolResult);
      expect(normalized.data).toEqual({ preexisting: true });
    });

    it('returns an error envelope unchanged (no sibling payload to lift)', () => {
      const result: ToolResult = { success: false, error: 'graph-unavailable' };
      const normalized = normalizeToolResult('compareCompetitors', result);
      expect(normalized).toEqual(result);
      expect(normalized.data).toBeUndefined();
    });
  });

  // ==========================================================================
  // Per-tool sibling-key lifting (AI-041)
  // ==========================================================================

  describe('read-only graph payloads are lifted into data', () => {
    it('lifts comparison for compareCompetitors and preserves the original key', () => {
      const comparison = {
        unique: [{ id: 't1', name: 'React' }],
        shared: [{ id: 't2', name: 'Vue' }],
        gaps: [{ id: 't3', name: 'Svelte' }],
      };
      const result = { success: true, comparison };
      const normalized = normalizeToolResult('compareCompetitors', result as unknown as ToolResult);

      expect(normalized.data).toEqual({ comparison });
      // Top-level payload preserved (no discarding).
      expect((normalized as unknown as { comparison: unknown }).comparison).toEqual(comparison);
    });

    it('lifts recommendations for recommendTechInvestments and preserves the original key', () => {
      const recommendations = [
        { technologyId: 't1', technologyName: 'Kubernetes', score: 87, reasons: ['cloud'] },
      ];
      const result = { success: true, recommendations };
      const normalized = normalizeToolResult(
        'recommendTechInvestments',
        result as unknown as ToolResult
      );

      expect(normalized.data).toEqual({ recommendations });
      expect((normalized as unknown as { recommendations: unknown }).recommendations).toEqual(
        recommendations
      );
    });

    it('lifts vendors for findVendors', () => {
      const vendors = [{ companyId: 'c1', companyName: 'Acme', alignmentScore: 90, technologies: [], explanation: 'x' }];
      const result = { success: true, vendors };
      const normalized = normalizeToolResult('findVendors', result as unknown as ToolResult);
      expect(normalized.data).toEqual({ vendors });
    });

    it('lifts summary for getTechSummary', () => {
      const summary = { technologyId: 't1', technologyName: 'React', impactReach: 5 };
      const result = { success: true, summary };
      const normalized = normalizeToolResult('getTechSummary', result as unknown as ToolResult);
      expect(normalized.data).toEqual({ summary });
    });
  });

  describe('read-only payloads are never reinterpreted as mutations', () => {
    it.each(['compareCompetitors', 'recommendTechInvestments', 'findVendors', 'getTechSummary'])(
      '%s lifts data without injecting mutatedEntityTypes',
      (tool) => {
        const result = { success: true, somePayload: [{ a: 1 }] };
        const normalized = normalizeToolResult(tool, result as unknown as ToolResult);
        const data = normalized.data as { mutatedEntityTypes?: unknown } | undefined;
        expect(data?.mutatedEntityTypes).toBeUndefined();
      }
    );
  });

  // ==========================================================================
  // generateVisualization mutation identity (AI-011)
  // ==========================================================================

  describe('generateVisualization identity', () => {
    it('surfaces the persisted Firestore visualizationId in structured data', () => {
      const result = {
        success: true,
        visualizationId: 'viz-abc123',
        imageUrl: 'https://storage.example.com/viz.png',
        url: '/infographics/viz-abc123',
      };
      const normalized = normalizeToolResult(
        'generateVisualization',
        result as unknown as ToolResult
      );

      expect(normalized.data).toEqual({
        visualizationId: 'viz-abc123',
        imageUrl: 'https://storage.example.com/viz.png',
        url: '/infographics/viz-abc123',
      });
      // Original top-level identity preserved.
      expect((normalized as unknown as { visualizationId: string }).visualizationId).toBe(
        'viz-abc123'
      );
    });

    it('keeps the storage object identity out of the structured data', () => {
      // The executor's storageObjectId is an internal detail; only the
      // persisted Firestore record id is the canonical identity surfaced here.
      const result = {
        success: true,
        visualizationId: 'viz-abc123',
        imageUrl: 'https://storage.example.com/viz.png',
        url: '/infographics/viz-abc123',
      };
      const normalized = normalizeToolResult(
        'generateVisualization',
        result as unknown as ToolResult
      );
      expect(normalized.data).not.toHaveProperty('storageObjectId');
      expect(normalized.data).not.toHaveProperty('storageObjectPath');
    });

    it('does not claim a mutation when persistence failed (no visualizationId)', () => {
      const result = { success: false, error: 'Image generated but save failed: Firestore down' };
      const normalized = normalizeToolResult(
        'generateVisualization',
        result as unknown as ToolResult
      );
      expect(normalized.success).toBe(false);
      expect(normalized.data).toBeUndefined();
      expect((normalized as unknown as { visualizationId?: string }).visualizationId).toBeUndefined();
    });
  });

  // ==========================================================================
  // Preservation
  // ==========================================================================

  describe('preservation', () => {
    it('preserves success, error, and message alongside lifted data', () => {
      const result = { success: true, comparison: { a: 1 }, message: 'partial' };
      const normalized = normalizeToolResult('compareCompetitors', result as unknown as ToolResult);
      expect(normalized.success).toBe(true);
      expect(normalized.message).toBe('partial');
      expect(normalized.data).toEqual({ comparison: { a: 1 } });
    });

    it('lifts only the defined sibling keys (undefined keys are skipped)', () => {
      // generateVisualization with only visualizationId present (no url/imageUrl).
      const result = { success: true, visualizationId: 'viz-1' };
      const normalized = normalizeToolResult(
        'generateVisualization',
        result as unknown as ToolResult
      );
      expect(normalized.data).toEqual({ visualizationId: 'viz-1' });
    });
  });
});
