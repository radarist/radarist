/**
 * @file lib/__tests__/nested-provider-usage.test.ts
 * @description ARUN-022 — the nested-provider attribution seam.
 *
 * These cover the two properties the chat/mission boundaries rely on:
 *   1. tool attribution is a DETERMINISTIC, schema-legal `operation` slug, so two
 *      nested calls of different tools can never share a receipt identity and a
 *      hostile tool name can never widen the receipt's value-level privacy
 *      boundary;
 *   2. the capture wrapper returns the callee's result unchanged, propagates its
 *      errors, and still yields whatever the provider chokepoints captured before
 *      the failure — spend that happened before a throw must not vanish.
 */

jest.mock('@/lib/firebase-admin', () => ({ db: {} }));

import {
  attributeCapturedUsageToTool,
  withNestedToolUsageCapture,
  nestedOperationSlug,
  MAX_NESTED_OPERATION_LENGTH,
} from '@/lib/nested-provider-usage';
import { captureProviderUsage } from '@/lib/operation-context';
import { createOperationReceiptSchema } from '@/lib/schemas/operation-receipt';
import type { CapturedProviderUsage } from '@/lib/operation-context';

function usage(overrides: Partial<CapturedProviderUsage> = {}): CapturedProviderUsage {
  return {
    provider: 'gemini',
    operation: 'gemini.generate-text',
    occurredAt: '2026-07-29T10:00:00.000Z',
    counters: { promptTokens: 10, outputTokens: 5 },
    usageCompleteness: 'complete',
    feeState: 'none',
    ...overrides,
  };
}

describe('nestedOperationSlug', () => {
  it('prefixes the chokepoint operation with the normalized tool name', () => {
    expect(nestedOperationSlug('deepResearch', 'gemini.generate-text')).toBe('tool.deepresearch.gemini.generate-text');
  });

  it('gives two different tools two different slugs for the same chokepoint', () => {
    const a = nestedOperationSlug('deepResearch', 'gemini.generate-text');
    const b = nestedOperationSlug('searchPapers', 'gemini.generate-text');
    expect(a).not.toBe(b);
  });

  it('is deterministic across calls (a replay derives the same identity)', () => {
    expect(nestedOperationSlug('generateInfographic', 'gemini.image')).toBe(
      nestedOperationSlug('generateInfographic', 'gemini.image')
    );
  });

  it('strips characters the receipt operation slug forbids instead of failing the write', () => {
    const slug = nestedOperationSlug('Evil Tool/../name~with spaces', 'gemini.generate-text');
    expect(slug).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(slug).toContain('gemini.generate-text');
  });

  it('never exceeds the receipt schema operation bound, even for a hostile long name', () => {
    const slug = nestedOperationSlug('x'.repeat(500), 'y'.repeat(500));
    expect(slug.length).toBeLessThanOrEqual(MAX_NESTED_OPERATION_LENGTH);
    expect(slug).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });

  it('keeps a distinct identity for two long tool names that share a prefix', () => {
    const base = 'a'.repeat(140);
    expect(nestedOperationSlug(`${base}one`, 'gemini.chat')).not.toBe(nestedOperationSlug(`${base}two`, 'gemini.chat'));
  });

  it('falls back to the chokepoint operation when the tool name normalizes to nothing', () => {
    expect(nestedOperationSlug('///', 'gemini.generate-text')).toBe('gemini.generate-text');
  });
});

describe('attributeCapturedUsageToTool', () => {
  it('rewrites only the operation and preserves every provider fact verbatim', () => {
    const original = usage({ requestedModel: 'gemini-3.5-flash', providerModel: 'gemini-3.5-flash' });
    const attributed = attributeCapturedUsageToTool(original, 'deepResearch');
    expect(attributed).toEqual({ ...original, operation: 'tool.deepresearch.gemini.generate-text' });
    // The input is not mutated — the caller's buffer stays untouched.
    expect(original.operation).toBe('gemini.generate-text');
  });

  it('produces an operation the receipt create schema accepts', () => {
    const attributed = attributeCapturedUsageToTool(usage(), 'importSignalToRadar');
    const parsed = createOperationReceiptSchema.safeParse({
      correlation: {
        parentType: 'chat-turn',
        owner: 'user:u1',
        correlationId: 'req-1',
        agentRunId: 'run-1',
      },
      operation: attributed.operation,
      invocationId: 'run-1.0',
      attempt: 0,
      responseOrdinal: 0,
      provider: attributed.provider,
      model: 'gemini-3.5-flash',
      modelProvenance: 'provider-reported',
      counters: attributed.counters,
      usageCompleteness: attributed.usageCompleteness,
      occurredAt: attributed.occurredAt,
      accountingScope: 'included-in-parent',
      feeState: attributed.feeState,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('withNestedToolUsageCapture', () => {
  it('returns the tool result unchanged and attributes everything captured inside it', async () => {
    const target: CapturedProviderUsage[] = [];
    const result = await withNestedToolUsageCapture('deepResearch', target, async () => {
      captureProviderUsage(usage());
      captureProviderUsage(usage({ operation: 'gemini.grounded-generate', feeState: 'applicable-but-unknown' }));
      return { ok: true } as const;
    });

    expect(result).toEqual({ ok: true });
    expect(target.map((c) => c.operation)).toEqual([
      'tool.deepresearch.gemini.generate-text',
      'tool.deepresearch.gemini.grounded-generate',
    ]);
    expect(target[1].feeState).toBe('applicable-but-unknown');
  });

  it('captures nothing when the tool made no provider call', async () => {
    const target: CapturedProviderUsage[] = [];
    await withNestedToolUsageCapture('getEntityDetails', target, async () => 'done');
    expect(target).toEqual([]);
  });

  it('preserves spend captured BEFORE a thrown tool error, and rethrows unchanged', async () => {
    const boom = new Error('tool exploded');
    const target: CapturedProviderUsage[] = [];
    await expect(
      withNestedToolUsageCapture('deepResearch', target, async () => {
        captureProviderUsage(usage());
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(target.map((c) => c.operation)).toEqual(['tool.deepresearch.gemini.generate-text']);
  });

  it('still records a provider response that arrives AFTER a read timeout rejected', async () => {
    const target: CapturedProviderUsage[] = [];
    let releaseLate: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });

    // The tool keeps running after the race rejects; its late capture must land.
    const raced = withNestedToolUsageCapture('deepResearch', target, () => {
      const work = late.then(() => {
        captureProviderUsage(usage({ operation: 'gemini.late' }));
        return 'too-late';
      });
      return Promise.race([work, Promise.reject(new Error('timeout: tool:deepResearch'))]);
    });

    await expect(raced).rejects.toThrow('timeout: tool:deepResearch');
    expect(target).toEqual([]);
    releaseLate();
    await late;
    // Flush the microtask queue so the orphaned continuation runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.map((c) => c.operation)).toEqual(['tool.deepresearch.gemini.late']);
  });

  it('isolates two concurrent tool executions from each other', async () => {
    const target: CapturedProviderUsage[] = [];
    const slow = withNestedToolUsageCapture('deepResearch', target, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      captureProviderUsage(usage({ operation: 'gemini.slow' }));
      return 'slow';
    });
    const fast = withNestedToolUsageCapture('searchPapers', target, async () => {
      captureProviderUsage(usage({ operation: 'gemini.fast' }));
      return 'fast';
    });
    await Promise.all([slow, fast]);
    expect(target.map((c) => c.operation).sort()).toEqual([
      'tool.deepresearch.gemini.slow',
      'tool.searchpapers.gemini.fast',
    ]);
  });
});
