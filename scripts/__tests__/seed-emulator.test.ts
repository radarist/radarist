/**
 * @file seed-emulator.test.ts
 * @description Validates the emulator seed's system-config document against
 * the canonical shared signal-source defaults (src/lib/signal-source-defaults.ts).
 *
 * Before the shared module existed, this seed carried a drifted hand-rolled
 * copy (funding: true — requires a paid API; trends: false). This test locks
 * the seed onto the single source of truth.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

// Mock Firebase modules so importing seed-emulator.ts does not trigger real
// connections (module top-level initializes a named app + emulator hookup).
jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({ name: 'radarist-emulator-seed' })),
  getApps: jest.fn(() => []),
  getApp: jest.fn(() => ({ name: 'radarist-emulator-seed' })),
}));

jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  connectFirestoreEmulator: jest.fn(),
  collection: jest.fn(),
  doc: jest.fn(),
  setDoc: jest.fn(),
  getDocs: jest.fn(),
  deleteDoc: jest.fn(),
  writeBatch: jest.fn(() => ({ set: jest.fn(), delete: jest.fn(), commit: jest.fn() })),
}));

// Stop the graph-sync import chain (pulls @/lib/graph → neo4j + firebase/auth).
jest.mock('../lib/seed-graph-sync', () => ({
  syncSeedToNeo4j: jest.fn(),
}));

// Project-id comes from env at module load — keep the test hermetic.
jest.mock('../lib/firebase-config', () => ({
  getScriptFirebaseProjectId: jest.fn(() => 'demo-test'),
}));

// .env.local side-effect loader — not needed under Jest.
jest.mock('../load-env-local', () => ({}));

import { DEFAULT_SIGNAL_SOURCES } from '@/lib/signal-source-defaults';
import { buildRelationTripleKey } from '@/lib/relations-triple-key';
import {
  EMULATOR_COLLECTIONS_TO_CLEAR,
  EMULATOR_RELATION_TRIPLE_LOCKS,
  SYSTEM_CONFIG_SEED,
} from '../seed-emulator';

describe('seed-emulator system configuration', () => {
  it('seeds signal sources from the shared canonical defaults', () => {
    expect(SYSTEM_CONFIG_SEED.signalDetection.sources).toEqual(DEFAULT_SIGNAL_SOURCES);
  });

  it('keeps the known-broken/paid sources disabled (patents retired, funding paid)', () => {
    expect(SYSTEM_CONFIG_SEED.signalDetection.sources.patents).toBe(false);
    expect(SYSTEM_CONFIG_SEED.signalDetection.sources.funding).toBe(false);
  });

  it('enables only registered working free sources', () => {
    expect(SYSTEM_CONFIG_SEED.signalDetection.sources.papers).toBe(true);
    expect(SYSTEM_CONFIG_SEED.signalDetection.sources.news).toBe(true);
    expect(SYSTEM_CONFIG_SEED.signalDetection.sources.github).toBe(true);
    expect(SYSTEM_CONFIG_SEED.signalDetection.sources.trends).toBe(false);
  });

  it('writes the singleton document shape getSystemConfig() expects', () => {
    expect(SYSTEM_CONFIG_SEED.id).toBe('global');
    expect(SYSTEM_CONFIG_SEED.agentMode.mode).toBe('copilot');
    expect(SYSTEM_CONFIG_SEED.signalDetection.enabled).toBe(true);
    expect(SYSTEM_CONFIG_SEED.agentMode.autoLinkRelationships).toBe(false);
    expect(SYSTEM_CONFIG_SEED.sweep).toEqual({ enabled: false, maxActionsPerSweep: 10 });
    expect(SYSTEM_CONFIG_SEED.linkerAgent.enabled).toBe(false);
    expect(SYSTEM_CONFIG_SEED.notifications.dashboard).toBe(true);
  });

  it('defines one deterministic owned triple lock per seeded relation', () => {
    expect(EMULATOR_RELATION_TRIPLE_LOCKS).toHaveLength(4);
    expect(EMULATOR_RELATION_TRIPLE_LOCKS).toContainEqual(
      expect.objectContaining({
        id: buildRelationTripleKey('anthropic-001', 'innovation-radar:1', 'vendor'),
        data: expect.objectContaining({ relationId: 'rel-001', relationType: 'vendor' }),
      })
    );
    expect(new Set(EMULATOR_RELATION_TRIPLE_LOCKS.map((lock) => lock.id)).size).toBe(
      EMULATOR_RELATION_TRIPLE_LOCKS.length
    );
  });

  it('clears relations, their locks, and all pending graph-sync anchors together', () => {
    expect(EMULATOR_COLLECTIONS_TO_CLEAR).toEqual(
      expect.arrayContaining([
        'relations',
        'relationTriples',
        'relationSyncOutbox',
        'entityGraphSyncOutbox',
        'graphReconciliationCursors',
      ])
    );
    expect(new Set(EMULATOR_COLLECTIONS_TO_CLEAR).size).toBe(EMULATOR_COLLECTIONS_TO_CLEAR.length);
  });
});
