/**
 * @file quick-action-tools-contract.test.ts
 * @description AI-006 — the QUICK_ACTION_TOOLS map (assistant-surface.ts) is
 * the machine-readable "backing tool per quick action" contract rendered into
 * docs/CAPABILITIES.md. This node-env suite cross-checks it against the real
 * tool catalog (importing tools.ts is too heavy for the jsdom quick-actions
 * suite — same placement rationale as core-tools-contract.test.ts next door):
 *
 *   (a) every mapped tool name exists in CORE_AI_TOOLS (offered to the chat
 *       model), not just ALL_AI_TOOLS;
 *   (b) every map key is a known QUICK_ACTION_MESSAGES action;
 *   (c) every AI-002 quick action (the six AI-001 page types' actions) carries
 *       a mapping — the actions whose prompts promise a concrete capability.
 *
 * @jest-environment node
 */
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: jest.fn((c: unknown, t: unknown, h: unknown) => h), send: jest.fn() },
}));

import { CORE_AI_TOOLS } from '@/lib/ai/tools';
import { getQuickActionsForContext, QUICK_ACTION_MESSAGES, QUICK_ACTION_TOOLS } from '@/lib/ai/assistant-surface';
import type { AIPageType } from '@/types/ai-assistant';

/** The AI-001 page types whose AI-002 quick actions promise a backing tool. */
const AI_002_PAGE_TYPES: AIPageType[] = [
  'reports',
  'artifacts',
  'infographics',
  'knowledge-graph',
  'assessment-triage',
  'insights',
];

/** Actions that are deliberately conversational (no single backing tool). */
const CONVERSATIONAL_ACTIONS = new Set(['navigation_help', 'explain_graph']);

describe('QUICK_ACTION_TOOLS contract (AI-006)', () => {
  const coreNames = new Set(CORE_AI_TOOLS.map((t) => t.name));

  it('every mapped tool name exists in CORE_AI_TOOLS', () => {
    const missing = Object.entries(QUICK_ACTION_TOOLS).flatMap(([action, tools]) =>
      tools.filter((t) => !coreNames.has(t)).map((t) => `${action} -> ${t}`)
    );
    expect(missing).toEqual([]);
  });

  it('every map key is a known quick action (no orphan tool mappings)', () => {
    const unknown = Object.keys(QUICK_ACTION_TOOLS).filter((action) => !(action in QUICK_ACTION_MESSAGES));
    expect(unknown).toEqual([]);
  });

  it('no mapping is empty — an entry must name at least one backing tool', () => {
    const empty = Object.entries(QUICK_ACTION_TOOLS)
      .filter(([, tools]) => tools.length === 0)
      .map(([action]) => action);
    expect(empty).toEqual([]);
  });

  it('every AI-002 quick action carries a backing-tool mapping', () => {
    const unmapped: string[] = [];
    for (const pageType of AI_002_PAGE_TYPES) {
      for (const action of getQuickActionsForContext(pageType, false)) {
        if (CONVERSATIONAL_ACTIONS.has(action.action)) continue;
        if (!(action.action in QUICK_ACTION_TOOLS)) unmapped.push(`${pageType}:${action.action}`);
      }
    }
    expect(unmapped).toEqual([]);
  });

  it('keeps multi-step quick actions self-contained instead of exposing stranded executors', () => {
    expect(QUICK_ACTION_TOOLS.draft_report).toEqual(
      expect.arrayContaining(['getArtifactFindings', 'startMission'])
    );
    expect(QUICK_ACTION_TOOLS.draft_report).not.toEqual(
      expect.arrayContaining(['draftReport', 'publishReport'])
    );
    expect(QUICK_ACTION_TOOLS.generate_infographic).toEqual(
      expect.arrayContaining(['listRadars', 'getRadarDetails', 'generateInfographic'])
    );
    expect(QUICK_ACTION_TOOLS.visualize_data).toEqual(
      expect.arrayContaining(['listRadars', 'getRadarDetails', 'generateVisualization'])
    );
    expect(QUICK_ACTION_TOOLS.approve_top_assessment).toEqual(
      expect.arrayContaining(['getPendingProposals', 'approveAssessment'])
    );
    expect(QUICK_ACTION_TOOLS.personalized_recommendations).toEqual(
      expect.arrayContaining(['listRadars', 'getRadarDetails', 'getPersonalizedRecommendations'])
    );
  });
});
