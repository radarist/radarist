/**
 * @file scripts/__tests__/demo-narrative-contract.test.ts
 * @description SKILL-002 — the seed contract test. Proves the real "State of AI
 * 2026" demo seed satisfies the demo-narrative contract (hero, no generic
 * tokens, a complete linked decision chain, coverage) and clears the benchmark,
 * while the generic anti-fixture scores far below it.
 *
 * Runs against the exported seed consts only — no emulator, fully deterministic.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

// Break the seed's firebase/graph import chain (mirrors seed-demo.test.ts).
jest.mock('firebase/app', () => ({ initializeApp: jest.fn(() => ({})) }));
jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  connectFirestoreEmulator: jest.fn(),
  collection: jest.fn(),
  getDocs: jest.fn(),
  writeBatch: jest.fn(() => ({ set: jest.fn(), delete: jest.fn(), commit: jest.fn() })),
  doc: jest.fn(),
}));
jest.mock('@/lib/graph/neo4j-client', () => ({ runWriteTransaction: jest.fn() }));
jest.mock('@/lib/graph/relation-assertion-sync', () => ({
  syncRelationAsAssertion: jest.fn(),
  syncRelationAsEdge: jest.fn(),
}));
jest.mock('@/lib/graph/preferences', () => ({ seedPreferenceWeight: jest.fn() }));
jest.mock('@/lib/graph/insight-actions', () => ({
  getInsightAction: jest.fn(() => ({ actionUrl: '/x', actionLabel: 'x' })),
}));

import { datasetFromSeed } from '../demo-narrative/from-seed';
import { evaluateDemoNarrative } from '../demo-narrative/evaluate';
import { GENERIC_ANTI_FIXTURE } from '../demo-narrative/anti-fixture';
import { DEMO_NARRATIVE_CONTRACT } from '../demo-narrative/contract';

describe('Demo-narrative contract — real "State of AI 2026" seed', () => {
  const dataset = datasetFromSeed();
  const receipt = evaluateDemoNarrative(dataset);

  it('passes every hard rule and clears the score threshold', () => {
    const failures = receipt.checks.filter((c) => c.status === 'fail');
    expect(failures.map((c) => `${c.id}: ${c.detail} ${(c.offenders ?? []).join(',')}`)).toEqual([]);
    expect(receipt.hardRulesPassed).toBe(true);
    expect(receipt.passed).toBe(true);
    expect(receipt.score).toBeGreaterThanOrEqual(DEMO_NARRATIVE_CONTRACT.scoreThreshold);
  });

  it('carries zero generic fixture tokens (no foo/bar/test123)', () => {
    const banned = receipt.checks.find((c) => c.id === 'no-banned-tokens');
    expect(banned?.offenders ?? []).toEqual([]);
    expect(banned?.status).toBe('pass');
  });

  it('designates the "State of AI 2026" radar as the hero, richly linked', () => {
    expect(receipt.hero.id).toBe('ai-radar-2026');
    expect(receipt.hero.label).toBe('State of AI 2026');
    expect(receipt.hero.linkedEntityCount).toBeGreaterThanOrEqual(DEMO_NARRATIVE_CONTRACT.heroMinLinkedEntities);
  });

  it('resolves the complete signal→technology→radar→report→run decision chain', () => {
    const linkage = receipt.checks.find((c) => c.id === 'narrative-linkage');
    expect(linkage?.score).toBe(1);
    const chain = receipt.checks.find((c) => c.id === 'chain-complete');
    expect(chain?.status).toBe('pass');
  });

  it('declares the canonical screenshot route as the radar view', () => {
    expect(receipt.canonicalScreenshotRoute).toBe('/visualizations/radar');
  });
});

describe('Demo-narrative contract — benchmark discrimination', () => {
  it('scores the real seed far above the generic anti-fixture', () => {
    const seedScore = evaluateDemoNarrative(datasetFromSeed()).score;
    const toyScore = evaluateDemoNarrative(GENERIC_ANTI_FIXTURE).score;
    // eslint-disable-next-line no-console
    console.log(`[demo-narrative] real seed score=${seedScore}/100, anti-fixture=${toyScore}/100`);
    expect(seedScore).toBeGreaterThanOrEqual(DEMO_NARRATIVE_CONTRACT.scoreThreshold);
    expect(toyScore).toBeLessThanOrEqual(DEMO_NARRATIVE_CONTRACT.antiFixtureCeiling);
    expect(seedScore - toyScore).toBeGreaterThanOrEqual(40);
  });
});
