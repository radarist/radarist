/**
 * @file core-tools-contract.test.ts
 * @description Regression guard for Bug B (2026-06-06): the Gemini
 * signal-creation-intent path forces `functionCallingConfig.allowedFunctionNames`,
 * which MUST be a subset of the declared tools (`CORE_AI_TOOLS`) or Gemini
 * returns 400 "allowed_function_names should be a subset of function_declarations".
 * Also guards CORE_AI_TOOLS ⊆ ALL_AI_TOOLS so a curated-list typo can't silently
 * drop an executor-backed tool.
 */
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: jest.fn((c: unknown, t: unknown, h: unknown) => h), send: jest.fn() },
}));

import { CORE_AI_TOOLS, ALL_AI_TOOLS } from '@/lib/ai/tools';
import { EXTERNAL_CONTENT_TOOLS } from '@/lib/ai/untrusted-tool-result';
import { MISSION_PRESETS } from '@/lib/mission-presets';

// Hard-coded forced allow-list in src/app/api/ai/chat/route.ts (signal-creation intent).
const SIGNAL_INTENT_FORCED = ['createSignalManual', 'listSignals', 'searchEntities'];
// Tools referenced by ROUTE_TOOLS/INTENT_TOOLS that had drifted out of CORE_AI_TOOLS.
const PREVIOUSLY_DRIFTED = ['createSignalManual', 'deleteRadar', 'draftReport', 'publishReport', 'updateRadarSettings'];

describe('CORE_AI_TOOLS contract (Bug B guard)', () => {
  const coreNames = new Set(CORE_AI_TOOLS.map((t) => t.name));
  const allNames = new Set(ALL_AI_TOOLS.map((t) => t.name));

  it('every CORE_AI_TOOLS entry exists in ALL_AI_TOOLS', () => {
    const missing = CORE_AI_TOOLS.map((t) => t.name).filter((n) => !allNames.has(n));
    expect(missing).toEqual([]);
  });

  it('the signal-intent forced allow-list is a subset of declared CORE_AI_TOOLS', () => {
    const notDeclared = SIGNAL_INTENT_FORCED.filter((n) => !coreNames.has(n));
    expect(notDeclared).toEqual([]);
  });

  it('previously-drifted tools are both executor-backed and sent to the model', () => {
    for (const n of PREVIOUSLY_DRIFTED) {
      expect(allNames.has(n)).toBe(true); // declared + dispatched
      expect(coreNames.has(n)).toBe(true); // and included in the model's tool set
    }
  });

  // P0.1 — the aggregate/analytics tools must stay in the chat allow-list, or
  // "how many X" questions regress to capped-listEntities guessing.
  it('exposes the aggregate/analytics tools (P0.1) so counts are answerable', () => {
    for (const n of ['getGraphAnalytics', 'findDataGaps', 'getTrends']) {
      expect(allNames.has(n)).toBe(true);
      expect(coreNames.has(n)).toBe(true);
    }
  });

  // draftDocument is a mission-scoped WRITE tool: it must be executor-backed
  // (in ALL) but NOT offered to the chat model (out of CORE), matching its
  // DOMAIN_ONLY_MUTATING_TOOLS + MISSION_BOUND_TOOLS classification.
  it('keeps draftDocument executor-backed but off the chat surface', () => {
    expect(allNames.has('draftDocument')).toBe(true);
    expect(coreNames.has('draftDocument')).toBe(false);
  });

  it('separates explicit relation writes from discovered relation proposals on chat', () => {
    for (const name of [
      'createRelation',
      'proposeVerifiedRelation',
      'listPendingProposedRelations',
      'getProposedRelationDetails',
      'approveProposedRelation',
    ]) {
      expect(coreNames.has(name)).toBe(true);
    }

    for (const name of ['createRelationsByName', 'createRelationWithEvidence', 'curateRelation', 'captureEvidence']) {
      expect(allNames.has(name)).toBe(true);
      expect(coreNames.has(name)).toBe(false);
    }
  });

  // Every mission preset (mission-presets.ts) pins a real backing tool. The
  // client-safe preset module can't import the tool catalog itself, so this is
  // the only guard that a preset's sourceTool typo can't slip through.
  it('every MISSION_PRESETS sourceTool is a registered AI tool', () => {
    const unknown = MISSION_PRESETS.map((p) => p.sourceTool).filter((n) => !allNames.has(n));
    expect(unknown).toEqual([]);
  });

  // SEC-010 — EXTERNAL_CONTENT_TOOLS drives BOTH the untrusted framing and the
  // `_source: 'web' | 'platform'` provenance label. A stale name is not a
  // harmless leftover: it is a tool that silently gets neither. The set
  // inherited three names (`webSearchGrounded`, `deepResearch`,
  // `refreshUrlDocument`) that have no declaration and no dispatch case.
  it('every EXTERNAL_CONTENT_TOOLS name is a registered AI tool', () => {
    const stale = [...EXTERNAL_CONTENT_TOOLS].filter((n) => !allNames.has(n));
    expect(stale).toEqual([]);
  });

  // AI-043 Contract 3 — recordCompanyReviewDecision carries the durable idempotency
  // identity minted by prepareCompanyReviewDecision. The DECLARATION the model sees
  // (in the CORE surface it is actually sent) must EXPOSE `idempotencyKey` and REQUIRE
  // it, or the function-calling layer strips it and an exact retry can never reach the
  // durable record. Guards against the field silently dropping out of the schema.
  it('recordCompanyReviewDecision exposes idempotencyKey as a required property in the CORE surface', () => {
    const decl = CORE_AI_TOOLS.find((t) => t.name === 'recordCompanyReviewDecision');
    expect(decl).toBeDefined();
    const params = decl!.parameters as {
      properties?: Record<string, { type?: unknown; description?: string }>;
      required?: string[];
    };
    expect(params.properties?.idempotencyKey).toBeDefined();
    expect(params.required).toContain('idempotencyKey');
    // Described as the exact server-issued value returned by prepare.
    expect(params.properties?.idempotencyKey?.description ?? '').toMatch(/prepareCompanyReviewDecision/);
    expect(params.properties?.idempotencyKey?.description ?? '').toMatch(/server-issued/i);
  });
});
