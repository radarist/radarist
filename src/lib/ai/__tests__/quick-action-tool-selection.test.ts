/**
 * @file quick-action-tool-selection.test.ts
 * @description PERF-010 trusted quick-action catalog contract and benchmark.
 *
 * @jest-environment node
 */

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: jest.fn((c: unknown, t: unknown, h: unknown) => h), send: jest.fn() },
}));

import { QUICK_ACTION_TOOLS } from '@/lib/ai/assistant-surface';
import {
  ASSISTANT_QUICK_ACTION_SOURCE,
  measureToolCatalog,
  measureToolCatalogReduction,
  selectToolsForQuickAction,
} from '@/lib/ai/quick-action-tool-selection';
import { CORE_AI_TOOLS } from '@/lib/ai/tools';

const metadata = (actionId: string) => ({ source: ASSISTANT_QUICK_ACTION_SOURCE, actionId });

describe('selectToolsForQuickAction', () => {
  it.each(Object.entries(QUICK_ACTION_TOOLS))(
    'selects exactly the declared backing tools for %s',
    (actionId, requiredToolNames) => {
      const selection = selectToolsForQuickAction(CORE_AI_TOOLS, metadata(actionId));

      expect(selection).toMatchObject({
        mode: 'quick-action',
        reason: 'trusted-quick-action',
        actionId,
        requiredToolNames,
      });
      expect(selection.tools.map((tool) => tool.name).sort()).toEqual([...requiredToolNames].sort());
      // No unrelated read or mutation capability can be introduced: selection
      // is the exact mapping, not the mapping plus a guessed helper set.
      expect(selection.tools.every((tool) => requiredToolNames.includes(tool.name))).toBe(true);
    }
  );

  it.each([
    undefined,
    null,
    'proactive_insights',
    { actionId: 'proactive_insights' },
    { source: 'user-message', actionId: 'proactive_insights' },
    { source: ASSISTANT_QUICK_ACTION_SOURCE, actionId: 42 },
    { source: ASSISTANT_QUICK_ACTION_SOURCE, actionId: 'PROACTIVE_INSIGHTS' },
    { source: ASSISTANT_QUICK_ACTION_SOURCE, actionId: ' proactive_insights ' },
  ])('keeps exact normal-catalog parity for missing or untrusted metadata %#', (turnMetadata) => {
    const selection = selectToolsForQuickAction(CORE_AI_TOOLS, turnMetadata);

    expect(selection.mode).toBe('normal');
    expect(selection.tools).toBe(CORE_AI_TOOLS);
    expect(selection.tools).toEqual(CORE_AI_TOOLS);
  });

  it.each(['does_not_exist', '__proto__', 'constructor', 'toString'])(
    'fails open for unknown or prototype-like action id %s',
    (actionId) => {
      const selection = selectToolsForQuickAction(CORE_AI_TOOLS, metadata(actionId));

      expect(selection).toMatchObject({ mode: 'normal', reason: 'unknown-action', actionId });
      expect(selection.tools).toBe(CORE_AI_TOOLS);
    }
  );

  it('fails open instead of presenting a partially capable quick action', () => {
    const withoutMissionDispatch = CORE_AI_TOOLS.filter((tool) => tool.name !== 'startMission');
    const selection = selectToolsForQuickAction(withoutMissionDispatch, metadata('draft_report'));

    expect(selection).toMatchObject({
      mode: 'normal',
      reason: 'incomplete-catalog',
      actionId: 'draft_report',
      requiredToolNames: QUICK_ACTION_TOOLS.draft_report,
    });
    expect(selection.tools).toBe(withoutMissionDispatch);
  });

  it('does not mutate the normal catalog', () => {
    const before = [...CORE_AI_TOOLS];
    selectToolsForQuickAction(CORE_AI_TOOLS, metadata('proactive_insights'));
    expect(CORE_AI_TOOLS).toEqual(before);
  });
});

describe('trusted quick-action declaration benchmark', () => {
  // 136 since AI-039 added `createRelations` to the chat surface (was 135);
  // 138 since SKILL-043 added the two observation reads.
  it('reproduces the 138-tool general catalog baseline', () => {
    const measurement = measureToolCatalog(CORE_AI_TOOLS);

    expect(measurement.toolCount).toBe(138);
    expect(measurement.serializedCharacters).toBeGreaterThan(150_000);
    expect(measurement.approximateTokens).toBeGreaterThan(40_000);
  });

  it('cuts at least 95% of declaration tokens for proactive insights', () => {
    const selection = selectToolsForQuickAction(CORE_AI_TOOLS, metadata('proactive_insights'));
    const selected = measureToolCatalog(selection.tools);
    const reduction = measureToolCatalogReduction(CORE_AI_TOOLS, selection.tools);

    expect(selection.tools.map((tool) => tool.name)).toEqual(['getProactiveInsights']);
    expect(selected.toolCount).toBe(1);
    // The catalog total minus the single tool this quick action keeps.
    expect(reduction.toolCount).toBe(137);
    expect(reduction.approximateTokens).toBeGreaterThan(40_000);
    expect(reduction.approximateTokenReductionRatio).toBeGreaterThan(0.95);
  });

  it('retains every required declaration while reducing every supported quick action', () => {
    for (const [actionId, requiredToolNames] of Object.entries(QUICK_ACTION_TOOLS)) {
      const selection = selectToolsForQuickAction(CORE_AI_TOOLS, metadata(actionId));
      const reduction = measureToolCatalogReduction(CORE_AI_TOOLS, selection.tools);

      expect(new Set(selection.tools.map((tool) => tool.name))).toEqual(new Set(requiredToolNames));
      expect(reduction.toolCount).toBeGreaterThan(0);
      expect(reduction.approximateTokens).toBeGreaterThan(0);
      expect(reduction.approximateTokenReductionRatio).toBeGreaterThan(0.9);
    }
  });
});
