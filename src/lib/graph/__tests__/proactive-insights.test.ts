/**
 * @file proactive-insights.test.ts
 * @description Unit tests for the proactive insight detection service.
 *
 * Tests cover:
 * - Agent observation recording
 * - Insight detection (cross-referencing observations with explored entities)
 * - Insight retrieval for users
 * - Insight consumption marking
 * - Insight statistics
 */

// ============================================================================
// MOCKS
// ============================================================================

jest.mock('@/lib/ai/client', () => ({ __esModule: true, generateStructuredContent: jest.fn() }));
jest.mock('@/lib/discovery/entity-topic', () => ({ __esModule: true, resolveEntityTopic: jest.fn() }));
jest.mock('@/lib/discovery/cold-start', () => ({ __esModule: true, getEffectivePreferences: jest.fn() }));
jest.mock('@/lib/proposed-artifacts-admin', () => ({
  __esModule: true,
  createProposedArtifactIfNotExists: jest.fn(),
}));

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runQuery: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn(() => Promise.resolve()),
}));

// Stub ensure-edges so it doesn't invoke extra runWriteTransaction calls
jest.mock('@/lib/graph/ensure-edges', () => ({
  __esModule: true,
  ensureEdgesForNode: jest.fn(() => Promise.resolve({ edgesCreated: 0 })),
  getEdgeRulesForType: jest.fn(() => []),
}));

// Mock crypto.randomUUID for deterministic IDs
let uuidCounter = 0;
const originalCrypto = global.crypto;
beforeAll(() => {
  Object.defineProperty(global, 'crypto', {
    value: {
      ...originalCrypto,
      randomUUID: jest.fn(() => {
        uuidCounter++;
        return `mock-uuid-${uuidCounter}`;
      }),
    },
    writable: true,
    configurable: true,
  });
});
afterAll(() => {
  Object.defineProperty(global, 'crypto', {
    value: originalCrypto,
    writable: true,
    configurable: true,
  });
});

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import neo4j from 'neo4j-driver';
import * as neo4jClient from '../neo4j-client';
import {
  recordAgentObservation,
  detectInsightsForUser,
  observeWatchedEntityUpdates,
  getInsightsForUser,
  markInsightConsumed,
  getInsightStats,
  getInsightEntityTypes,
  getInsightTopics,
  purgeStaleConnectionInsights,
  setInsightLikedState,
  recordInsightView,
  getInsightById,
  setInsightConsumedState,
  bulkSetInsightsConsumed,
  generateNarrativeInsights,
  ObservationTargetNotFoundError,
} from '../proactive-insights';
import type { AgentObservation } from '../proactive-insights';
import { generateStructuredContent } from '@/lib/ai/client';
import { resolveEntityTopic } from '@/lib/discovery/entity-topic';
import { getEffectivePreferences } from '@/lib/discovery/cold-start';
import { createProposedArtifactIfNotExists } from '@/lib/proposed-artifacts-admin';

const mockGenStructured = generateStructuredContent as jest.Mock;
const mockResolveEntityTopic = resolveEntityTopic as jest.Mock;
const mockGetEffectivePreferences = getEffectivePreferences as jest.Mock;
const mockCreateProposedArtifact = createProposedArtifactIfNotExists as jest.Mock;

const mockedWriteTransaction = neo4jClient.runWriteTransaction as jest.Mock;
const mockedReadTransaction = neo4jClient.runReadTransaction as jest.Mock;

// ============================================================================
// HELPERS
// ============================================================================

function createMockQueryResult<T>(records: T[], nodesCreated = 1) {
  return {
    records,
    summary: {
      counters: {
        nodesCreated,
        nodesDeleted: 0,
        relationshipsCreated: 0,
        relationshipsDeleted: 0,
        propertiesSet: 0,
      },
      queryType: 'rw',
      resultAvailableAfter: 1,
      resultConsumedAfter: 0,
    },
  };
}

function createMockObservationInput(): Omit<AgentObservation, 'id'> {
  return {
    agentType: 'scout',
    observationType: 'discovery',
    title: 'New quantum computing breakthrough',
    summary: 'IonQ announced a new 35-qubit processor with improved error rates.',
    confidence: 0.87,
    entityId: 'tech-quantum',
    entityName: 'Quantum Computing',
    entityType: 'technology',
    timestamp: '2026-02-23T12:00:00.000Z',
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('proactive-insights', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    uuidCounter = 0;
    // Neutral preference-ranking defaults so all pre-existing detectInsightsForUser
    // tests (≤3 observations, well under MAX_INSIGHTS_PER_RUN) stay green unmodified —
    // no topic/pref means rankObservationsByPreference is a confidence-order no-op.
    mockGetEffectivePreferences.mockResolvedValue([]);
    mockResolveEntityTopic.mockResolvedValue('t-x');
  });

  // --------------------------------------------------------------------------
  // recordAgentObservation
  // --------------------------------------------------------------------------

  describe('recordAgentObservation', () => {
    it('creates AgentObservation node and ABOUT edge', async () => {
      const input = createMockObservationInput();

      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            id: 'mock-uuid-1',
            agentType: input.agentType,
            observationType: input.observationType,
            title: input.title,
            summary: input.summary,
            confidence: input.confidence,
            entityId: input.entityId,
            entityName: input.entityName,
            entityType: input.entityType,
            timestamp: input.timestamp,
          },
        ])
      );

      const result = await recordAgentObservation(input);

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];

      // Verify Cypher creates the observation node
      expect(cypher).toContain('CREATE (obs:AgentObservation');
      expect(cypher).toContain('id: $id');
      expect(cypher).toContain('agentType: $agentType');
      expect(cypher).toContain('observationType: $observationType');
      expect(cypher).toContain('confidence: $confidence');

      // Verify Cypher creates ABOUT edge
      expect(cypher).toContain('MATCH (candidate {id: $entityId})');
      expect(cypher).toContain('WHERE size(targets) = 1');
      expect(cypher).toContain('MERGE (obs)-[:ABOUT]->(e)');

      // Verify parameters
      expect(params.agentType).toBe('scout');
      expect(params.observationType).toBe('discovery');
      expect(params.entityId).toBe('tech-quantum');
      expect(params.confidence).toBe(0.87);
      expect(params.memoryLane).toBe('proactive-standalone');

      // Verify returned observation
      expect(result).toEqual({
        id: 'mock-uuid-1',
        agentType: 'scout',
        observationType: 'discovery',
        title: input.title,
        summary: input.summary,
        confidence: 0.87,
        entityId: 'tech-quantum',
        entityName: 'Quantum Computing',
        entityType: 'technology',
        timestamp: '2026-02-23T12:00:00.000Z',
      });
    });

    it('generates UUID for id', async () => {
      const input = createMockObservationInput();

      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            id: 'mock-uuid-1',
            ...input,
          },
        ])
      );

      await recordAgentObservation(input);

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.id).toBe('mock-uuid-1');
    });

    it('throws and logs error when write transaction fails', async () => {
      mockedWriteTransaction.mockRejectedValue(new Error('Neo4j write failed'));

      await expect(recordAgentObservation(createMockObservationInput())).rejects.toThrow('Neo4j write failed');
    });

    it('throws ObservationTargetNotFoundError and creates nothing when the entity does not exist', async () => {
      const input = createMockObservationInput();
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      let caught: unknown;
      try {
        await recordAgentObservation(input);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ObservationTargetNotFoundError);
      expect((caught as ObservationTargetNotFoundError).entityId).toBe(input.entityId);
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
    });

    it('requires one exact entity target instead of choosing an arbitrary duplicate', async () => {
      const input = createMockObservationInput();
      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            id: 'mock-uuid-1',
            ...input,
          },
        ])
      );

      await recordAgentObservation(input);

      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('WITH collect(DISTINCT candidate) AS targets');
      expect(cypher).toContain('WHERE size(targets) = 1');
      expect(cypher).not.toContain('LIMIT 1');
    });
  });

  // --------------------------------------------------------------------------
  // detectInsightsForUser
  // --------------------------------------------------------------------------

  describe('detectInsightsForUser', () => {
    it('finds observations about explored entities', async () => {
      const matchedObs = [
        {
          obsId: 'obs-1',
          type: 'discovery',
          title: 'New quantum paper',
          summary: 'A new paper on quantum error correction.',
          agentName: 'scout',
          confidence: 0.9,
          entityId: 'tech-quantum',
          entityName: 'Quantum Computing',
          entityType: 'technology',
          timestamp: '2026-02-23T10:00:00.000Z',
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      const result = await detectInsightsForUser('user-abc');

      expect(mockedReadTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedReadTransaction.mock.calls[0];

      // Verify the core cross-reference query
      expect(cypher).toContain(
        'MATCH (s:Session { userId: $userId })-[:EXPLORED]->(e)<-[:ABOUT]-(obs:AgentObservation)'
      );
      expect(cypher).toContain('obs.timestamp > $since');
      expect(cypher).toContain('NOT EXISTS');
      expect(cypher).toContain('ORDER BY obs.confidence DESC');

      expect(params.userId).toBe('user-abc');
      expect(params.since).toBeDefined();

      expect(result.observationsMatched).toBe(1);
      expect(result.userId).toBe('user-abc');
    });

    it('creates ProactiveInsight nodes for matches', async () => {
      const matchedObs = [
        {
          obsId: 'obs-1',
          type: 'discovery',
          title: 'Discovery about quantum',
          summary: 'Some quantum discovery.',
          agentName: 'scout',
          confidence: 0.9,
          entityId: 'tech-quantum',
          entityName: 'Quantum Computing',
          entityType: 'technology',
          timestamp: '2026-02-23T10:00:00.000Z',
        },
        {
          obsId: 'obs-2',
          type: 'connection',
          title: 'Link found between Acme and quantum',
          summary: 'Acme Corp invested in quantum.',
          agentName: 'linker',
          confidence: 0.85,
          entityId: 'comp-acme',
          entityName: 'Acme Corp',
          entityType: 'company',
          timestamp: '2026-02-23T11:00:00.000Z',
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      const result = await detectInsightsForUser('user-abc');

      // Should create one insight per matched observation
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(2);
      expect(result.insightsCreated).toBe(2);
      expect(result.observationsMatched).toBe(2);

      // Verify first insight creation Cypher
      const [cypher1, params1] = mockedWriteTransaction.mock.calls[0];
      expect(cypher1).toContain('MERGE (pi:ProactiveInsight { id: $id })');
      expect(cypher1).toContain('MERGE (pi)-[:ABOUT]->(e)');
      expect(cypher1).toContain('pi.epistemicKind = $epistemicKind');
      expect(cypher1).toContain("pi.groundingVersion = 'agent-observation-v1'");
      expect(params1.userId).toBe('user-abc');
      expect(params1.sourceObservationId).toBe('obs-1');
      expect(params1.epistemicKind).toBe('observation');
      expect(params1.title).toBe('Source observation: Discovery about quantum');
      expect(params1.summary).toBe('Observed by scout: Some quantum discovery.');
      expect(params1.type).toBe('discovery');
      expect(params1.agentName).toBe('scout');
      expect(params1.confidence).toBe(0.9);

      // Verify second insight
      const [, params2] = mockedWriteTransaction.mock.calls[1];
      expect(params2.type).toBe('connection');
      expect(params2.agentName).toBe('linker');
      expect(params2.epistemicKind).toBe('inference');
      expect(params2.title).toBe('Hypothesis: Link found between Acme and quantum');
      expect(params2.summary).toBe('Inference from linker: Acme Corp invested in quantum.');
      expect(params2.confidence).toBe(0.5);
    });

    it('does not count or announce a replayed insight MERGE as a creation', async () => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            obsId: 'obs-replayed',
            type: 'discovery',
            title: 'Existing discovery',
            summary: 'Already surfaced.',
            agentName: 'scout',
            confidence: 0.9,
            entityId: 'tech-existing',
            entityName: 'Existing Tech',
            entityType: 'technology',
            timestamp: '2026-02-23T10:00:00.000Z',
          },
        ])
      );
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([], 0));

      const result = await detectInsightsForUser('user-abc');

      expect(result).toEqual({ insightsCreated: 0, observationsMatched: 1, userId: 'user-abc' });
      const { emitAgentEvent } = jest.requireMock('@/lib/agent-events') as {
        emitAgentEvent: jest.Mock;
      };
      expect(emitAgentEvent).not.toHaveBeenCalled();
    });

    it.each([
      ['scoring_change', 'observation', 'Source observation:', 0.9],
      ['pattern', 'inference', 'Hypothesis:', 0.5],
      ['unexpected_type', 'inference', 'Hypothesis:', 0.5],
    ])('classifies %s source rows as %s with a visible label', async (type, kind, titlePrefix, confidence) => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            obsId: `obs-${type}`,
            type,
            title: 'Agent output',
            summary: 'Agent reasoning.',
            agentName: 'scout',
            confidence: 0.9,
            entityId: 'tech-a',
            entityName: 'Tech A',
            entityType: 'technology',
            timestamp: '2026-02-23T10:00:00.000Z',
          },
        ])
      );
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await detectInsightsForUser('user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.epistemicKind).toBe(kind);
      expect(params.title).toMatch(new RegExp(`^${titlePrefix}`));
      expect(params.confidence).toBe(confidence);
    });

    it('returns 0 when no matches found', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      const result = await detectInsightsForUser('user-xyz');

      expect(result).toEqual({
        insightsCreated: 0,
        observationsMatched: 0,
        userId: 'user-xyz',
      });

      // Should NOT call write transaction when no matches
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });

    it('uses default 24-hour window', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await detectInsightsForUser('user-abc');

      const [, params] = mockedReadTransaction.mock.calls[0];
      const sinceDate = new Date(params.since as string);
      const expected = new Date(Date.now() - 24 * 60 * 60 * 1000);
      // Allow 2 second tolerance
      expect(Math.abs(sinceDate.getTime() - expected.getTime())).toBeLessThan(2000);
    });

    it('uses custom sinceMs when provided', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      const oneHourMs = 60 * 60 * 1000;
      await detectInsightsForUser('user-abc', oneHourMs);

      const [, params] = mockedReadTransaction.mock.calls[0];
      const sinceDate = new Date(params.since as string);
      const expected = new Date(Date.now() - oneHourMs);
      expect(Math.abs(sinceDate.getTime() - expected.getTime())).toBeLessThan(2000);
    });

    it('generates correct actionUrl for company entities', async () => {
      const matchedObs = [
        {
          obsId: 'obs-1',
          type: 'discovery',
          title: 'Acme update',
          summary: 'Update about Acme.',
          agentName: 'scout',
          confidence: 0.8,
          entityId: 'comp-acme',
          entityName: 'Acme Corp',
          entityType: 'company',
          timestamp: '2026-02-23T10:00:00.000Z',
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await detectInsightsForUser('user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.actionUrl).toBe('/library/companies?company=comp-acme');
      expect(params.actionLabel).toBe('View company');
    });

    it('generates correct actionUrl for technology entities', async () => {
      const matchedObs = [
        {
          obsId: 'obs-1',
          type: 'scoring_change',
          title: 'Tech score updated',
          summary: 'Score changed.',
          agentName: 'evaluator',
          confidence: 0.75,
          entityId: 'tech-wasm',
          entityName: 'WebAssembly',
          entityType: 'technology',
          timestamp: '2026-02-23T10:00:00.000Z',
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await detectInsightsForUser('user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.actionUrl).toBe('/library/technologies?technology=tech-wasm');
      expect(params.actionLabel).toBe('View technology');
    });

    it('generates correct actionUrl for signal entities', async () => {
      const matchedObs = [
        {
          obsId: 'obs-1',
          type: 'pattern',
          title: 'Signal pattern',
          summary: 'Pattern detected.',
          agentName: 'monitor',
          confidence: 0.82,
          entityId: 'sig-1',
          entityName: 'Edge AI Signal',
          entityType: 'signal',
          timestamp: '2026-02-23T10:00:00.000Z',
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await detectInsightsForUser('user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.actionUrl).toBe('/triage/signals');
      expect(params.actionLabel).toBe('Review signals');
    });

    it('routes a prototype observation through the unified insight-action helper', async () => {
      // Updated by Phase 0 step 0.4 — prototype used to fall through to the
      // generic `/library` default. After unification it has its own
      // canonical destination via `getInsightAction`.
      const matchedObs = [
        {
          obsId: 'obs-1',
          type: 'discovery',
          title: 'Prototype update',
          summary: 'Update.',
          agentName: 'scout',
          confidence: 0.7,
          entityId: 'proto-1',
          entityName: 'PoC Alpha',
          entityType: 'prototype',
          timestamp: '2026-02-23T10:00:00.000Z',
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await detectInsightsForUser('user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.actionUrl).toBe('/library/prototypes?prototype=proto-1');
      expect(params.actionLabel).toBe('View prototype');
    });

    it('persists actionUrl=null for genuinely unknown entity types (no /library fallback)', async () => {
      // The previous default sent unknown types to the
      // /library home page — a useless click destination. The new helper
      // returns null so the UI (and the 0.6 quality gate) can filter
      // these rows out cleanly.
      const matchedObs = [
        {
          obsId: 'obs-1',
          type: 'discovery',
          title: 'Mystery thing',
          summary: 'Something.',
          agentName: 'scout',
          confidence: 0.7,
          entityId: 'm-1',
          entityName: 'M',
          entityType: 'mystery',
          timestamp: '2026-02-23T10:00:00.000Z',
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await detectInsightsForUser('user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.actionUrl).toBeNull();
      expect(params.actionLabel).toBe('View entity');
    });

    it('continues processing when individual insight creation fails', async () => {
      const matchedObs = [
        {
          obsId: 'obs-1',
          type: 'discovery',
          title: 'First observation',
          summary: 'First.',
          agentName: 'scout',
          confidence: 0.9,
          entityId: 'tech-1',
          entityName: 'Tech 1',
          entityType: 'technology',
          timestamp: '2026-02-23T10:00:00.000Z',
        },
        {
          obsId: 'obs-2',
          type: 'connection',
          title: 'Second observation',
          summary: 'Second.',
          agentName: 'linker',
          confidence: 0.8,
          entityId: 'tech-2',
          entityName: 'Tech 2',
          entityType: 'technology',
          timestamp: '2026-02-23T11:00:00.000Z',
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));

      // First write fails, second succeeds
      mockedWriteTransaction
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce(createMockQueryResult([]));

      const result = await detectInsightsForUser('user-abc');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(2);
      expect(result.insightsCreated).toBe(1); // Only the successful one
      expect(result.observationsMatched).toBe(2);
    });

    it('throws when the initial read transaction fails', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Read failed'));

      await expect(detectInsightsForUser('user-abc')).rejects.toThrow('Read failed');
    });

    it('de-noises: excludes sweep-cycle bookkeeping observations from surfacing', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
      await detectInsightsForUser('user-abc');
      const [query] = mockedReadTransaction.mock.calls[0];
      expect(query).toContain("obs.agentType <> 'sweep-cycle'");
    });

    it('deduplicates by caller and source observation, not by any newer insight about the entity (UX-051)', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await detectInsightsForUser('user-abc');

      const [query] = mockedReadTransaction.mock.calls[0];
      expect(query).toContain('sourceObservationId: obs.id');
      expect(query).not.toContain('pi.createdAt >= obs.timestamp');
    });

    it('uses a deterministic MERGE identity so concurrent sweep retries converge on one durable insight', async () => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            obsId: 'obs-stable-1',
            type: 'discovery',
            title: 'Stable update',
            summary: 'A stable update.',
            agentName: 'interest-watch',
            confidence: 0.7,
            entityId: 'tech-1',
            entityName: 'Technology 1',
            entityType: 'technology',
            timestamp: '2026-07-20T00:00:00.000Z',
          },
        ])
      );
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await detectInsightsForUser('user-abc');

      const [query, params] = mockedWriteTransaction.mock.calls[0];
      expect(query).toContain('MERGE (pi:ProactiveInsight { id: $id })');
      expect(query).toContain('ON CREATE SET');
      expect(params).toMatchObject({ userId: 'user-abc', sourceObservationId: 'obs-stable-1' });

      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            obsId: 'obs-stable-1',
            type: 'discovery',
            title: 'Stable update',
            summary: 'A stable update.',
            agentName: 'interest-watch',
            confidence: 0.7,
            entityId: 'tech-1',
            entityName: 'Technology 1',
            entityType: 'technology',
            timestamp: '2026-07-20T00:00:00.000Z',
          },
        ])
      );
      await detectInsightsForUser('user-abc');
      expect(mockedWriteTransaction.mock.calls[1][1].id).toBe(params.id);
    });

    // --------------------------------------------------------------------------
    // US-5 (Stage 3 task 14): preference-aware ranking + MAX_INSIGHTS_PER_RUN cap
    // --------------------------------------------------------------------------

    function makeMatchedObs(overrides: Record<string, unknown> = {}) {
      return {
        obsId: 'obs-x',
        type: 'discovery',
        title: 'x',
        summary: 'x summary',
        agentName: 'scout',
        confidence: 0.5,
        entityId: 'e-x',
        entityName: 'X',
        entityType: 'technology',
        timestamp: '2026-02-23T10:00:00.000Z',
        ...overrides,
      };
    }

    it('caps insight creation at 5 per run', async () => {
      // 7 matched observations, confidence-desc (the real Cypher query's ORDER BY).
      const matchedObs = Array.from({ length: 7 }, (_, i) =>
        makeMatchedObs({
          obsId: `obs-${i}`,
          entityId: `e-${i}`,
          title: `Obs ${i}`,
          confidence: 0.9 - i * 0.01,
        })
      );
      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      const result = await detectInsightsForUser('user-abc');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(5);
      expect(result).toEqual({ insightsCreated: 5, observationsMatched: 7, userId: 'user-abc' });
    });

    it('creates insights in preference-ranked order', async () => {
      // Lower-confidence observation is on a boosted topic; higher-confidence
      // observation is on an unmapped (neutral) topic. Boosted should win:
      // 0.5 * (1 + min(1,0.8)*0.5) = 0.70 > 0.6 * 1 = 0.60.
      const boosted = makeMatchedObs({
        obsId: 'obs-boosted',
        entityId: 'e-boosted',
        title: 'Boosted (lower raw confidence)',
        confidence: 0.5,
      });
      const neutral = makeMatchedObs({
        obsId: 'obs-neutral',
        entityId: 'e-neutral',
        title: 'Neutral (higher raw confidence)',
        confidence: 0.6,
      });
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([neutral, boosted]));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      mockGetEffectivePreferences.mockResolvedValue([
        { topic: 't-boost', weight: 0.8, actedCount: 5, dismissedCount: 0 },
      ]);
      mockResolveEntityTopic.mockImplementation((entityId: string) =>
        Promise.resolve(entityId === 'e-boosted' ? 't-boost' : 't-unmapped')
      );

      await detectInsightsForUser('user-abc');

      const [, firstParams] = mockedWriteTransaction.mock.calls[0];
      expect(firstParams.title).toBe('Source observation: Boosted (lower raw confidence)');
    });

    it('falls back to confidence order (still capped) when getEffectivePreferences rejects', async () => {
      const matchedObs = Array.from({ length: 7 }, (_, i) =>
        makeMatchedObs({
          obsId: `obs-${i}`,
          entityId: `e-${i}`,
          title: `Obs ${i}`,
          confidence: 0.9 - i * 0.01,
        })
      );
      mockedReadTransaction.mockResolvedValue(createMockQueryResult(matchedObs));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));
      mockGetEffectivePreferences.mockRejectedValue(new Error('cold-start unavailable'));

      const result = await detectInsightsForUser('user-abc');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(5);
      expect(result).toEqual({ insightsCreated: 5, observationsMatched: 7, userId: 'user-abc' });
      // Fallback preserves the query's own confidence-DESC order — first 5 of 7.
      const titles = mockedWriteTransaction.mock.calls.map(([, params]) => params.title);
      expect(titles).toEqual([
        'Source observation: Obs 0',
        'Source observation: Obs 1',
        'Source observation: Obs 2',
        'Source observation: Obs 3',
        'Source observation: Obs 4',
      ]);
    });

    it('a resolveEntityTopic failure degrades that entity to neutral, not the whole run', async () => {
      const bad = makeMatchedObs({
        obsId: 'obs-bad',
        entityId: 'e-bad',
        entityType: 'technology',
        title: 'Bad-entity obs',
        confidence: 0.5,
      });
      const good = makeMatchedObs({
        obsId: 'obs-good',
        entityId: 'e-good',
        entityType: 'technology',
        title: 'Good-entity obs',
        confidence: 0.5,
      });
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([bad, good]));
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      // Only 'e-good' resolves to the boosted topic; 'e-bad' rejects, so its
      // per-entity `.catch(() => entityType)` degrades it to the coarse
      // 'technology' topic — which has no preference row, i.e. neutral.
      mockGetEffectivePreferences.mockResolvedValue([
        { topic: 't-boost', weight: 0.9, actedCount: 5, dismissedCount: 0 },
      ]);
      mockResolveEntityTopic.mockImplementation((entityId: string) =>
        entityId === 'e-bad' ? Promise.reject(new Error('firestore down')) : Promise.resolve('t-boost')
      );

      const result = await detectInsightsForUser('user-abc');

      // Both still surfaced — the run was not collapsed by the one bad read.
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(2);
      expect(result.insightsCreated).toBe(2);
      // 'e-good' is boosted (0.5*1.45=0.725) and outranks the neutral 'e-bad' (0.5*1=0.5).
      const [, firstParams] = mockedWriteTransaction.mock.calls[0];
      expect(firstParams.title).toBe('Source observation: Good-entity obs');
    });
  });

  // --------------------------------------------------------------------------
  // observeWatchedEntityUpdates
  // --------------------------------------------------------------------------

  describe('observeWatchedEntityUpdates', () => {
    it('records interest-watch observations for entities changed since first viewed and returns the count', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([{ created: 2 }]));

      const created = await observeWatchedEntityUpdates('user-1');

      expect(created).toBe(2);
      const [query, params] = mockedWriteTransaction.mock.calls[0];
      // scoped to the user's explored entities, keyed on the changed-since-MOST-RECENT-view
      // signal (not first view), and collapsed per entity id (robust to duplicate nodes).
      expect(query).toContain("agentType: 'interest-watch'");
      expect(query).toContain('max(coalesce(rel.lastViewedAt, rel.firstViewedAt))');
      expect(query).toContain('datetime(lastViewed).epochMillis');
      expect(query).toContain('e.id AS entityId'); // group/dedup by id, not node identity
      expect(query).toContain('sourceUpdatedAt'); // dedupe key so a given update fires once
      expect(params).toMatchObject({ userId: 'user-1' });
    });

    it('returns 0 when no explored entity has changed since it was viewed', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([{ created: 0 }]));
      expect(await observeWatchedEntityUpdates('user-1')).toBe(0);
    });

    it('propagates a write failure (never silently swallows into "no insights")', async () => {
      mockedWriteTransaction.mockRejectedValue(new Error('neo4j unavailable'));
      await expect(observeWatchedEntityUpdates('user-1')).rejects.toThrow('neo4j unavailable');
    });
  });

  // --------------------------------------------------------------------------
  // getInsightsForUser
  // --------------------------------------------------------------------------

  describe('getInsightsForUser', () => {
    it('returns unconsumed insights with related entities', async () => {
      const mockInsights = [
        {
          id: 'insight-1',
          type: 'discovery',
          title: 'Quantum breakthrough',
          summary: 'IonQ announced new processor.',
          agentName: 'scout',
          confidenceScore: 0.87,
          actionable: true,
          actionUrl: '/library/technologies?sheet=tech-quantum',
          actionLabel: 'View technology',
          createdAt: '2026-02-23T12:00:00.000Z',
          liked: true,
          entities: [{ id: 'tech-quantum', name: 'Quantum Computing', type: 'technology' }],
        },
        {
          id: 'insight-2',
          type: 'connection',
          title: 'Acme-Quantum link',
          summary: 'Acme invested in quantum.',
          agentName: 'linker',
          confidenceScore: 0.92,
          actionable: true,
          actionUrl: '/library/companies?sheet=comp-acme',
          actionLabel: 'View company',
          createdAt: '2026-02-23T11:00:00.000Z',
          liked: false,
          entities: [
            { id: 'comp-acme', name: 'Acme Corp', type: 'company' },
            { id: 'tech-quantum', name: 'Quantum Computing', type: 'technology' },
          ],
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(mockInsights));

      const insights = await getInsightsForUser('user-abc');

      expect(mockedReadTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedReadTransaction.mock.calls[0];

      expect(cypher).toContain('MATCH (pi:ProactiveInsight { userId: $userId, consumed: false })');
      expect(cypher).toContain('OPTIONAL MATCH (pi)-[:ABOUT]->(e)');
      expect(cypher).toContain('collect({ id: e.id, name: coalesce(e.name, e.title), type: e.entityType })');
      // Liked insights re-rank first, then confidence, then recency.
      expect(cypher).toContain('ORDER BY coalesce(pi.liked, false) DESC, pi.confidenceScore DESC, pi.createdAt DESC');
      expect(cypher).toContain('LIMIT $limit');
      expect(params.userId).toBe('user-abc');
      expect(params.limit).toEqual(neo4j.int(20));

      expect(insights).toHaveLength(2);
      expect(insights[0]).toEqual({
        id: 'insight-1',
        userId: 'user-abc',
        type: 'discovery',
        title: 'Quantum breakthrough',
        summary: 'IonQ announced new processor.',
        agentName: 'scout',
        confidenceScore: 0.87,
        relatedEntities: [{ id: 'tech-quantum', name: 'Quantum Computing', type: 'technology' }],
        actionable: true,
        actionUrl: '/library/technologies?sheet=tech-quantum',
        actionLabel: 'View technology',
        createdAt: '2026-02-23T12:00:00.000Z',
        consumed: false,
        liked: true,
      });
      expect(insights[1].liked).toBe(false);
    });

    it('uses default limit of 20', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await getInsightsForUser('user-abc');

      const [, params] = mockedReadTransaction.mock.calls[0];
      expect(params.limit).toEqual(neo4j.int(20));
    });

    it('uses custom limit when provided', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await getInsightsForUser('user-abc', 5);

      const [, params] = mockedReadTransaction.mock.calls[0];
      expect(params.limit).toEqual(neo4j.int(5));
    });

    it('returns empty array when no insights found', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      const insights = await getInsightsForUser('user-abc');
      expect(insights).toEqual([]);
    });

    it('throws and logs error when read transaction fails', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Read failed'));

      await expect(getInsightsForUser('user-abc')).rejects.toThrow('Read failed');
    });

    // -----------------------------------------------------------------------
    // Quality-gate filter contract
    //
    // The Cypher must enforce four predicates so that legacy / leaked rows
    // never reach the UI. These tests pin each predicate against the
    // generated query string. The actual filtering happens in Neo4j; we
    // assert the contract is in the query, not that Neo4j honours it.
    // -----------------------------------------------------------------------

    describe('quality gate (Phase 0 step 0.6)', () => {
      it('requires confidenceScore >= 0.4', async () => {
        mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
        await getInsightsForUser('user-abc');
        const [cypher] = mockedReadTransaction.mock.calls[0];
        expect(cypher).toContain('pi.confidenceScore >= 0.4');
      });

      it('surfaces only fully grounded counter-evidence at the honest 0.35 floor', async () => {
        mockedReadTransaction.mockResolvedValue(
          createMockQueryResult([
            {
              id: 'pi-counter',
              type: 'connection',
              title: 'Possible conflict',
              summary: 'Counter-evidence path.',
              agentName: 'linker',
              confidenceScore: 0.35,
              actionable: true,
              actionUrl: '/library/technologies?technology=tech-a',
              actionLabel: 'View technology',
              createdAt: '2026-07-17T00:00:00.000Z',
              observedEntityId: 'tech-a',
              exploredEntityId: 'tech-b',
              liked: false,
              relationshipTypes: ['USES', 'COMPETES_WITH'],
              relationshipDirections: ['forward', 'reverse'],
              pathLength: 2,
              exploredAt: null,
              entities: [],
            },
          ])
        );

        const insights = await getInsightsForUser('user-abc');
        const [cypher] = mockedReadTransaction.mock.calls[0];
        expect(cypher).toContain("pi.groundingVersion = 'predicate-path-v1'");
        expect(cypher).toContain("pi.epistemicKind = 'inference'");
        expect(cypher).toContain('pi.hasCounterEvidence = true');
        expect(cypher).toContain('pi.confidenceScore >= 0.35');
        expect(insights).toHaveLength(1);
      });

      it('requires actionUrl IS NOT NULL', async () => {
        mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
        await getInsightsForUser('user-abc');
        const [cypher] = mockedReadTransaction.mock.calls[0];
        expect(cypher).toContain('pi.actionUrl IS NOT NULL');
      });

      it("excludes the legacy '/library' fallback URL", async () => {
        mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
        await getInsightsForUser('user-abc');
        const [cypher] = mockedReadTransaction.mock.calls[0];
        expect(cypher).toContain("pi.actionUrl <> '/library'");
      });

      it("does NOT deny agentName='sweep-cycle' (legit dot-connector output inherits it)", async () => {
        // The agentName deny-list was dropped at step 0.9 after live
        // verification showed the dot-connector copies the source
        // observation's agent name into the insight — so ALL legit
        // connectDots output appears with agentName='sweep-cycle' too. The
        // bookkeeping leak is closed at the write side (step 0.3); we
        // can't distinguish leak from legit by agentName.
        mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
        await getInsightsForUser('user-abc');
        const [cypher] = mockedReadTransaction.mock.calls[0];
        expect(cypher).not.toContain("NOT pi.agentName IN ['sweep-cycle']");
        expect(cypher).not.toContain('pi.agentName IN');
      });

      it('keeps the WHERE clause attached to the same MATCH as the userId+consumed filter', async () => {
        // Regression guard: a WHERE clause that lands after the OPTIONAL
        // MATCH would filter by the related entity instead of the insight.
        mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
        await getInsightsForUser('user-abc');
        const [cypher] = mockedReadTransaction.mock.calls[0];
        const whereIdx = cypher.indexOf('WHERE (pi.confidenceScore');
        const optionalIdx = cypher.indexOf('OPTIONAL MATCH');
        expect(whereIdx).toBeGreaterThan(0);
        expect(whereIdx).toBeLessThan(optionalIdx);
      });
    });

    // -----------------------------------------------------------------------
    // Phase 0 step 0.11 — surface `liked` for Option A's table
    //
    // The briefing read query must project `pi.liked` so the upcoming table
    // UI can render the filled-thumb state without a second round-trip. The
    // coalesce default keeps legacy rows (where the property was never set)
    // returning `false` instead of `null`.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // Structured path data flows through
    //
    // The read query must project `relationshipTypes`, `pathLength`,
    // `exploredAt` so the detail-page UI can render the breadcrumb without a
    // second round-trip. Pre-A.0 rows lack these properties; the mapping
    // converts the missing/null to `undefined` so consumers can use optional
    // chaining and fall back to the human-readable summary string.
    // -----------------------------------------------------------------------
    describe('A.0 structured path data', () => {
      it('projects relationshipTypes, pathLength, exploredAt in the Cypher', async () => {
        mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
        await getInsightsForUser('user-abc');
        const [cypher] = mockedReadTransaction.mock.calls[0];
        expect(cypher).toContain('pi.relationshipTypes AS relationshipTypes');
        expect(cypher).toContain('pi.sourceRelationTypes AS sourceRelationTypes');
        expect(cypher).toContain('pi.relationshipDirections AS relationshipDirections');
        expect(cypher).toContain('pi.evidenceSummary AS evidenceSummary');
        expect(cypher).toContain('pi.pathLength AS pathLength');
        expect(cypher).toContain('pi.exploredAt AS exploredAt');
      });

      it('surfaces the three fields when present', async () => {
        mockedReadTransaction.mockResolvedValue(
          createMockQueryResult([
            {
              id: 'insight-a0-1',
              type: 'connection',
              title: 'Quantum-IBM link',
              summary: 'IBM is 2 hops from Quantum via VENDOR → USES.',
              agentName: 'scout',
              confidenceScore: 0.7,
              actionable: true,
              actionUrl: '/library/companies?sheet=comp-ibm',
              actionLabel: 'View company',
              createdAt: '2026-05-13T00:00:00.000Z',
              liked: false,
              relationshipTypes: ['VENDOR', 'USES'],
              sourceRelationTypes: ['vendor', 'uses'],
              relationshipDirections: ['forward', 'reverse'],
              evidenceSummary: 'Technology A -[VENDOR]-> Company B <-[USES]- Technology C',
              groundingVersion: 'predicate-path-v1',
              epistemicKind: 'inference',
              pathLength: 2,
              exploredAt: '2026-05-10T12:00:00.000Z',
              entities: [{ id: 'comp-ibm', name: 'IBM', type: 'company' }],
            },
          ])
        );

        const insights = await getInsightsForUser('user-abc');

        expect(insights[0].relationshipTypes).toEqual(['VENDOR', 'USES']);
        expect(insights[0].sourceRelationTypes).toEqual(['vendor', 'uses']);
        expect(insights[0].relationshipDirections).toEqual(['forward', 'reverse']);
        expect(insights[0].evidenceSummary).toContain('<-[USES]-');
        expect(insights[0].epistemicKind).toBe('inference');
        expect(insights[0].pathLength).toBe(2);
        expect(insights[0].exploredAt).toBe('2026-05-10T12:00:00.000Z');
      });

      it('defaults structured grounding fields to undefined for legacy rows missing the properties', async () => {
        mockedReadTransaction.mockResolvedValue(
          createMockQueryResult([
            {
              id: 'insight-legacy',
              type: 'discovery',
              title: 'Pre-A.0 row',
              summary: 'No structured path data persisted.',
              agentName: 'scout',
              confidenceScore: 0.8,
              actionable: true,
              actionUrl: '/library/companies?sheet=c1',
              actionLabel: 'View company',
              createdAt: '2026-04-01T00:00:00.000Z',
              liked: false,
              // relationshipTypes / pathLength / exploredAt all omitted
              entities: [{ id: 'c1', name: 'Acme', type: 'company' }],
            },
          ])
        );

        const insights = await getInsightsForUser('user-abc');

        expect(insights[0].relationshipTypes).toBeUndefined();
        expect(insights[0].sourceRelationTypes).toBeUndefined();
        expect(insights[0].relationshipDirections).toBeUndefined();
        expect(insights[0].evidenceSummary).toBeUndefined();
        expect(insights[0].groundingVersion).toBeUndefined();
        expect(insights[0].epistemicKind).toBeUndefined();
        expect(insights[0].pathLength).toBeUndefined();
        expect(insights[0].exploredAt).toBeUndefined();
      });
    });

    describe('liked field (Phase 0 step 0.11)', () => {
      it('projects coalesce(pi.liked, false) AS liked in the Cypher', async () => {
        mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
        await getInsightsForUser('user-abc');
        const [cypher] = mockedReadTransaction.mock.calls[0];
        expect(cypher).toContain('coalesce(pi.liked, false) AS liked');
      });

      it('defaults liked to false when the record value is null or missing', async () => {
        mockedReadTransaction.mockResolvedValue(
          createMockQueryResult([
            {
              id: 'insight-legacy-null',
              type: 'discovery',
              title: 'Legacy row',
              summary: 'No liked property persisted yet.',
              agentName: 'scout',
              confidenceScore: 0.8,
              actionable: true,
              actionUrl: '/library/companies?sheet=c1',
              actionLabel: 'View company',
              createdAt: '2026-05-13T00:00:00.000Z',
              liked: null,
              entities: [{ id: 'c1', name: 'Acme', type: 'company' }],
            },
            {
              id: 'insight-legacy-missing',
              type: 'discovery',
              title: 'Legacy row 2',
              summary: 'Property entirely absent.',
              agentName: 'scout',
              confidenceScore: 0.8,
              actionable: true,
              actionUrl: '/library/companies?sheet=c2',
              actionLabel: 'View company',
              createdAt: '2026-05-13T00:00:00.000Z',
              // liked omitted from record
              entities: [{ id: 'c2', name: 'Beta', type: 'company' }],
            },
          ])
        );

        const insights = await getInsightsForUser('user-abc');

        expect(insights[0].liked).toBe(false);
        expect(insights[1].liked).toBe(false);
      });
    });
  });

  // --------------------------------------------------------------------------
  // markInsightConsumed
  // --------------------------------------------------------------------------

  describe('markInsightConsumed', () => {
    it('sets consumed flag and consumedAt timestamp', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await markInsightConsumed('insight-123', 'user-123');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];

      expect(cypher).toContain('MATCH (pi:ProactiveInsight { id: $id, userId: $userId })');
      expect(cypher).toContain('SET pi.consumed = true');
      expect(cypher).toContain('pi.consumedAt = $now');

      expect(params.id).toBe('insight-123');
      expect(params.now).toBeDefined();
      // Verify the timestamp is a valid ISO string
      expect(new Date(params.now as string).toISOString()).toBe(params.now);
    });

    it('throws and logs error when write transaction fails', async () => {
      mockedWriteTransaction.mockRejectedValue(new Error('Write failed'));

      await expect(markInsightConsumed('insight-123', 'user-123')).rejects.toThrow('Write failed');
    });
  });

  // --------------------------------------------------------------------------
  // getInsightStats
  // --------------------------------------------------------------------------

  describe('getInsightStats', () => {
    it('returns correct counts', async () => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            total: 15,
            unconsumed: 7,
            lastDetectedAt: '2026-02-23T14:00:00.000Z',
          },
        ])
      );

      const stats = await getInsightStats('user-abc');

      expect(mockedReadTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedReadTransaction.mock.calls[0];

      expect(cypher).toContain('MATCH (pi:ProactiveInsight { userId: $userId })');
      expect(cypher).toContain('count(pi) AS total');
      expect(cypher).toContain('sum(CASE WHEN pi.consumed = false THEN 1 ELSE 0 END) AS unconsumed');
      expect(cypher).toContain('max(pi.createdAt) AS lastDetectedAt');
      expect(params.userId).toBe('user-abc');

      expect(stats).toEqual({
        total: 15,
        unconsumed: 7,
        lastDetectedAt: '2026-02-23T14:00:00.000Z',
      });
    });

    it('returns zeros when no insights exist', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      const stats = await getInsightStats('user-xyz');

      expect(stats).toEqual({
        total: 0,
        unconsumed: 0,
        lastDetectedAt: null,
      });
    });

    it('handles null lastDetectedAt in result', async () => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            total: 0,
            unconsumed: 0,
            lastDetectedAt: null,
          },
        ])
      );

      const stats = await getInsightStats('user-abc');

      expect(stats.lastDetectedAt).toBeNull();
    });

    it('throws and logs error when read transaction fails', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Read failed'));

      await expect(getInsightStats('user-abc')).rejects.toThrow('Read failed');
    });
  });

  // -------------------------------------------------------------------------
  // getInsightEntityTypes topic-derivation regression
  //
  // The /api/graph/preference route uses this helper to find the topic(s)
  // for a preference write. Before the fix, the route passed the raw action
  // string as the topic, producing zombie rows. These tests pin the Cypher
  // contract and the swallow-on-failure semantics.
  // -------------------------------------------------------------------------

  describe('getInsightEntityTypes', () => {
    it('returns distinct entity types from ABOUT-linked entities', async () => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([{ entityType: 'technology' }, { entityType: 'company' }])
      );

      const types = await getInsightEntityTypes('insight-123', 'user-123');

      expect(types).toEqual(['technology', 'company']);
      const [cypher, params] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('MATCH (pi:ProactiveInsight { id: $id, userId: $userId })-[:ABOUT]->(e)');
      expect(cypher).toContain('DISTINCT e.entityType');
      expect(params).toEqual({ id: 'insight-123', userId: 'user-123' });
    });

    it('filters out null and empty entityTypes', async () => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          { entityType: 'technology' },
          { entityType: null },
          { entityType: '' },
          { entityType: 'company' },
        ])
      );

      const types = await getInsightEntityTypes('insight-123', 'user-123');

      expect(types).toEqual(['technology', 'company']);
    });

    it('returns [] when the insight has no ABOUT-linked entities', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      const types = await getInsightEntityTypes('insight-orphan', 'user-123');

      expect(types).toEqual([]);
    });

    it('returns [] gracefully when Neo4j read fails (does not throw)', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Neo4j down'));

      // Caller-side: skipping the preference write is preferable to a 500.
      const types = await getInsightEntityTypes('insight-123', 'user-123');

      expect(types).toEqual([]);
    });
  });

  describe('getInsightTopics', () => {
    it('resolves subject entities to their TAG topic (the selector key-space), deduped', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [
          { id: 't1', entityType: 'technology' },
          { id: 't2', entityType: 'technology' },
        ],
      });
      const { resolveEntityTopic } = require('@/lib/discovery/entity-topic');
      (resolveEntityTopic as jest.Mock)
        .mockResolvedValueOnce('vector-database')
        .mockResolvedValueOnce('vector-database');

      const topics = await getInsightTopics('insight-123', 'user-123');

      expect(resolveEntityTopic).toHaveBeenCalledWith('t1', 'technology'); // NOT the coarse entityType
      expect(topics).toEqual(['vector-database']); // deduped
    });

    it('returns [] gracefully on a read failure', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Neo4j down'));
      expect(await getInsightTopics('insight-123', 'user-123')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // purgeStaleConnectionInsights cleanup regression
  //
  // Pins the selection criteria so the cleanup never widens its blast radius
  // beyond pre-fix connection insights. The reliable staleness marker is
  // `observedEntityId IS NULL` — that property is only set by the
  // post-2026-05-12 MERGE path, so its absence singles out the bad batch
  // without touching legit insights or other types.
  // -------------------------------------------------------------------------

  describe('purgeStaleConnectionInsights', () => {
    it('soft-consumes connection insights lacking observedEntityId', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([{ purged: 42 }]));

      const purged = await purgeStaleConnectionInsights();

      expect(purged).toBe(42);
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];

      // Selection criteria — never widen these without thought:
      //   type='connection' AND consumed=false AND observedEntityId IS NULL.
      expect(cypher).toContain("type: 'connection'");
      expect(cypher).toContain('consumed: false');
      expect(cypher).toContain('pi.observedEntityId IS NULL');

      // Never DELETE — we soft-consume to preserve the audit trail.
      expect(cypher).not.toContain('DELETE');
      expect(cypher).toContain('SET pi.consumed = true');
      expect(cypher).toContain('pi.consumedAt = $now');
      expect(cypher).toContain("pi.purgedReason = 'pre-2026-05-13-stale'");

      // $now is a real ISO timestamp the function just generated.
      expect(new Date(params.now as string).toISOString()).toBe(params.now);
    });

    it('returns 0 when nothing matched', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([{ purged: 0 }]));

      const purged = await purgeStaleConnectionInsights();

      expect(purged).toBe(0);
    });

    it('returns 0 when the driver returns no records at all', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      const purged = await purgeStaleConnectionInsights();

      expect(purged).toBe(0);
    });

    it('propagates the error when the write transaction fails', async () => {
      mockedWriteTransaction.mockRejectedValue(new Error('Neo4j unavailable'));

      await expect(purgeStaleConnectionInsights()).rejects.toThrow('Neo4j unavailable');
    });
  });

  // ==========================================================================
  // Option A step A.1 — engagement helpers
  // ==========================================================================

  describe('setInsightLikedState', () => {
    it('returns exists=false when the insight is missing', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));
      const result = await setInsightLikedState('missing', true, 'user-123');
      expect(result).toEqual({ exists: false, previousLiked: false });
    });

    it('returns previousLiked + exists=true and writes the SET clause', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([{ previousLiked: false }]));

      const result = await setInsightLikedState('pi-1', true, 'user-123');

      expect(result).toEqual({ exists: true, previousLiked: false });
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      // Reads prior state in the same transaction (idempotency contract).
      expect(cypher).toContain('coalesce(pi.liked, false) AS previousLiked');
      expect(cypher).toContain('SET pi.liked = $liked');
      // Sets likedAt to datetime() on the false → true edge, clears on
      // true → false, leaves alone otherwise.
      expect(cypher).toContain('WHEN $liked = true AND previousLiked = false THEN datetime()');
      expect(cypher).toContain('WHEN $liked = false THEN null');
      expect(params).toEqual({ id: 'pi-1', liked: true, userId: 'user-123' });
    });

    it('coerces a truthy/falsy neo4j-driver boolean to a strict JS boolean', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([{ previousLiked: 1 as unknown as boolean }]));
      const result = await setInsightLikedState('pi-1', false, 'user-123');
      expect(typeof result.previousLiked).toBe('boolean');
      expect(result.previousLiked).toBe(true);
    });

    it('propagates Neo4j errors', async () => {
      mockedWriteTransaction.mockRejectedValue(new Error('Neo4j down'));
      await expect(setInsightLikedState('pi-1', true, 'user-123')).rejects.toThrow('Neo4j down');
    });
  });

  describe('recordInsightView', () => {
    it('returns recorded=true on first MERGE (no prior VIEWED_INSIGHT edge)', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([{ isNew: true }]));

      const result = await recordInsightView('sess-1', 'pi-1', 'user-123');

      expect(result).toEqual({ exists: true, recorded: true });
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      // The sentinel edge is the dedupe mechanism — `OPTIONAL MATCH` +
      // `existing IS NULL AS isNew` lets us detect "did we create".
      expect(cypher).toContain('OPTIONAL MATCH (s)-[existing:VIEWED_INSIGHT]->(pi)');
      expect(cypher).toContain('existing IS NULL AS isNew');
      expect(cypher).toContain('CREATE (s)-[:VIEWED_INSIGHT { viewedAt: datetime() }]->(pi)');
      expect(params).toEqual({ sessionId: 'sess-1', insightId: 'pi-1', userId: 'user-123' });
    });

    it('returns recorded=false on second call within the same session', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([{ isNew: false }]));
      const result = await recordInsightView('sess-1', 'pi-1', 'user-123');
      expect(result).toEqual({ exists: true, recorded: false });
    });

    it('returns exists=false when session or insight is missing', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));
      const result = await recordInsightView('missing-sess', 'pi-1', 'user-123');
      expect(result).toEqual({ exists: false, recorded: false });
    });
  });

  describe('getInsightById', () => {
    it('returns null when the insight is missing', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
      const result = await getInsightById('missing', 'user-123');
      expect(result).toBeNull();
    });

    it('returns the full payload including A.0 structured-path fields', async () => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            id: 'pi-1',
            userId: 'sweep-system',
            type: 'connection',
            title: 'Quantum-IBM link',
            summary: 'Connection via VENDOR → USES.',
            agentName: 'scout',
            confidenceScore: 0.7,
            actionable: true,
            actionUrl: '/library/companies?sheet=comp-ibm',
            actionLabel: 'View company',
            createdAt: '2026-05-13T00:00:00.000Z',
            consumed: false,
            observedEntityId: 'comp-ibm',
            exploredEntityId: 'tech-quantum',
            liked: true,
            relationshipTypes: ['VENDOR', 'USES'],
            sourceRelationTypes: ['vendor', 'uses'],
            relationshipDirections: ['forward', 'reverse'],
            evidenceSummary: 'IBM -[VENDOR]-> Platform <-[USES]- Quantum',
            groundingVersion: 'predicate-path-v1',
            epistemicKind: 'inference',
            pathLength: 2,
            exploredAt: '2026-05-10T12:00:00.000Z',
            entities: [{ id: 'comp-ibm', name: 'IBM', type: 'company' }],
          },
        ])
      );

      const insight = await getInsightById('pi-1', 'user-123');
      expect(insight).not.toBeNull();
      expect(insight?.id).toBe('pi-1');
      expect(insight?.liked).toBe(true);
      expect(insight?.relationshipTypes).toEqual(['VENDOR', 'USES']);
      expect(insight?.sourceRelationTypes).toEqual(['vendor', 'uses']);
      expect(insight?.relationshipDirections).toEqual(['forward', 'reverse']);
      expect(insight?.evidenceSummary).toContain('<-[USES]-');
      expect(insight?.groundingVersion).toBe('predicate-path-v1');
      expect(insight?.epistemicKind).toBe('inference');
      expect(insight?.pathLength).toBe(2);
      expect(insight?.exploredAt).toBe('2026-05-10T12:00:00.000Z');
      expect(insight?.relatedEntities).toEqual([{ id: 'comp-ibm', name: 'IBM', type: 'company' }]);
    });

    it('binds the owner uid in the MATCH — a foreign id is the same miss as an absent id (SEC-008)', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
      await getInsightById('pi-1', 'user-123');
      const [cypher, params] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('MATCH (pi:ProactiveInsight { id: $id, userId: $userId })');
      expect(cypher).toContain('pi.sourceRelationTypes AS sourceRelationTypes');
      expect(cypher).toContain('pi.relationshipDirections AS relationshipDirections');
      expect(cypher).toContain('pi.evidenceSummary AS evidenceSummary');
      expect(cypher).toContain('pi.groundingVersion AS groundingVersion');
      expect(cypher).toContain('pi.epistemicKind AS epistemicKind');
      expect(params).toEqual({ id: 'pi-1', userId: 'user-123' });
    });
  });

  // ==========================================================================
  // Option A step A.2 — dismiss / undismiss primitives
  // ==========================================================================

  describe('setInsightConsumedState', () => {
    it('returns exists=false when the insight is missing', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));
      const result = await setInsightConsumedState('missing', true, 'user-123');
      expect(result).toEqual({ exists: false, previousConsumed: false, previousTopics: [] });
    });

    it('writes SET clauses for consumed, consumedAt, and lastDismissWroteTopics', async () => {
      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([{ previousConsumed: false, previousTopics: [] }])
      );

      const result = await setInsightConsumedState('pi-1', true, 'user-123', { topics: ['technology', 'company'] });

      expect(result.exists).toBe(true);
      expect(result.previousConsumed).toBe(false);

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      // Idempotency contract: prior state read in same transaction as the SET.
      expect(cypher).toContain('coalesce(pi.consumed, false) AS previousConsumed');
      expect(cypher).toContain('coalesce(pi.lastDismissWroteTopics, []) AS previousTopics');
      expect(cypher).toContain('SET pi.consumed = $consumed');
      // consumedAt set only on false → true edge so re-dismiss doesn't move it.
      expect(cypher).toContain('WHEN $consumed = true AND previousConsumed = false THEN $now');
      expect(cypher).toContain('WHEN $consumed = false THEN null');
      // The marker persists on dismiss, clears on undismiss.
      expect(cypher).toContain('pi.lastDismissWroteTopics = CASE');
      expect(params.id).toBe('pi-1');
      expect(params.consumed).toBe(true);
      expect(params.topics).toEqual(['technology', 'company']);
    });

    it('passes an empty topics list when none are provided (deterministic write)', async () => {
      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([{ previousConsumed: false, previousTopics: [] }])
      );

      await setInsightConsumedState('pi-1', true, 'user-123');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      // Empty list (not undefined) — Neo4j can't store undefined and we
      // want the SET to be deterministic.
      expect(params.topics).toEqual([]);
    });

    it('returns previousTopics so undo can roll back the right rows', async () => {
      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([{ previousConsumed: true, previousTopics: ['technology', 'company'] }])
      );

      const result = await setInsightConsumedState('pi-1', false, 'user-123');

      expect(result.previousConsumed).toBe(true);
      expect(result.previousTopics).toEqual(['technology', 'company']);
    });

    it('returns an empty topic list when neo4j-driver hands back null', async () => {
      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([{ previousConsumed: true, previousTopics: null }])
      );

      const result = await setInsightConsumedState('pi-legacy', false, 'user-123');
      expect(result.previousTopics).toEqual([]);
    });
  });

  describe('bulkSetInsightsConsumed', () => {
    it('short-circuits on an empty id list — no DB call', async () => {
      const result = await bulkSetInsightsConsumed([], true, 'user-123');
      expect(result).toEqual({ changed: 0 });
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });

    it('only flips rows whose state differs from the target (no double-write)', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([{ changed: 2 }]));

      const result = await bulkSetInsightsConsumed(['pi-1', 'pi-2', 'pi-3'], true, 'user-123');
      expect(result).toEqual({ changed: 2 });

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('UNWIND $ids AS id');
      // The `previousConsumed <> $consumed` guard is what makes bulk
      // re-dismiss idempotent.
      expect(cypher).toContain('WHERE previousConsumed <> $consumed');
      // Bulk does not write lastDismissWroteTopics — per Q3 it skips
      // preference writes, so there's no marker to record.
      expect(cypher).toContain('pi.lastDismissWroteTopics = null');
      expect(params.ids).toEqual(['pi-1', 'pi-2', 'pi-3']);
      expect(params.consumed).toBe(true);
    });

    it('flattens neo4j Integer counts into plain JS numbers', async () => {
      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([{ changed: { low: 42, high: 0 } as unknown as number }])
      );

      const result = await bulkSetInsightsConsumed(['pi-1'], true, 'user-123');
      expect(result.changed).toBe(42);
    });
  });

  describe('generateNarrativeInsights', () => {
    const chain = {
      strategyId: 's1',
      strategy: 'AI 2025',
      rel1: 'ALIGNS_WITH',
      rel1SourceType: 'aligns_with',
      rel1RelationId: 'rel-aligns',
      rel1AssertedBy: 'user:u1',
      rel1ClaimStatus: 'curated',
      rel1Confidence: 100,
      rel1StartId: 's1',
      rel1EndId: 't1',
      midType: 'Technology',
      midId: 't1',
      mid: 'AI Agents',
      rel2: 'USES',
      rel2SourceType: 'uses',
      rel2RelationId: 'rel-uses',
      rel2AssertedBy: 'user:u1',
      rel2ClaimStatus: 'curated',
      rel2Confidence: 100,
      rel2StartId: 't1',
      rel2EndId: 's2',
      endType: 'Strategy',
      endId: 's2',
      end: 'Leadership',
    };

    it('interprets a graph chain into a narrative ProactiveInsight (title + summary + impact)', async () => {
      mockedReadTransaction.mockResolvedValue({ records: [chain] });
      mockGenStructured.mockResolvedValue({
        insight: {
          title: 'Adjacent theme to assess',
          narrative: 'The reviewed proximity may indicate a theme worth investigating.',
          impact: 'Further research could assess its relevance because the path is indirect.',
          confidence: 88,
        },
      });
      mockedWriteTransaction.mockResolvedValue({ records: [] });

      const n = await generateNarrativeInsights('u1', { limit: 1, recommendReports: true });

      expect(n).toBe(1);
      const [readCypher] = mockedReadTransaction.mock.calls[0];
      expect(readCypher).toContain('r1.t_invalidated IS NULL');
      expect(readCypher).toContain('r2.t_invalidated IS NULL');
      expect(readCypher).toContain("coalesce(r1.claimStatus, 'curated') <> 'rejected'");
      expect(readCypher).toContain('r1.sourceRelationType AS rel1SourceType');
      expect(readCypher).toContain('r1.relationId AS rel1RelationId');
      expect(readCypher).toContain('r1.assertedBy AS rel1AssertedBy');
      expect(readCypher).toContain('r1.claimStatus AS rel1ClaimStatus');
      expect(readCypher).not.toContain("coalesce(r1.claimStatus, 'curated') AS rel1ClaimStatus");
      expect(readCypher).toContain(
        'coalesce(r1.effectiveConfidence, r1.assertedConfidence, r1.confidence) AS rel1Confidence'
      );
      expect(readCypher).toContain('startNode(r1).id AS rel1StartId');
      const [, readParams] = mockedReadTransaction.mock.calls[0];
      expect(readParams.semanticPredicates).toEqual(expect.arrayContaining(['ALIGNS_WITH', 'USES']));
      expect(mockGenStructured).toHaveBeenCalled();
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain("pi.type='narrative'");
      expect(params.title).toBe('Hypothesis: Adjacent theme to assess');
      expect(params.summary).toContain('Observed graph path:');
      expect(params.summary).toContain(
        'Inference (hypothesis): The reviewed proximity may indicate a theme worth investigating.'
      );
      expect(params.summary).toContain(
        'Potential impact (hypothesis): Further research could assess its relevance because the path is indirect.'
      );
      expect(params.epistemicKind).toBe('inference');
      expect(params.evidenceRelationIds).toEqual(['rel-aligns', 'rel-uses']);
      expect(params.evidenceAssertedBy).toEqual(['user:u1', 'user:u1']);
      expect(params.evidenceEdgeConfidences).toEqual([100, 100]);
      expect(params.relationshipTypes).toEqual(['ALIGNS_WITH', 'USES']);
      expect(params.pathLength).toBe(2);
      expect(params.hasCounterEvidence).toBe(false);
      // confidenceScore is normalized 0–1 (model returns 0–100); the UI renders ×100 as a %.
      expect(params.confidence).toBe(0.5);
      expect(params.strategyId).toBe('s1');
      expect(mockCreateProposedArtifact).toHaveBeenCalledTimes(1);
    });

    it('fails closed before model generation when an edge has no durable provenance', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [{ ...chain, rel2RelationId: null }],
      });

      const n = await generateNarrativeInsights('u1', { limit: 1, recommendReports: true });

      expect(n).toBe(0);
      expect(mockGenStructured).not.toHaveBeenCalled();
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });

    it('renders reversed edge direction from graph endpoints instead of inventing direction', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [
          {
            ...chain,
            rel1StartId: 't1',
            rel1EndId: 's1',
          },
        ],
      });
      mockGenStructured.mockResolvedValue({
        insight: {
          title: 'Possible effect',
          narrative: 'A possible interpretation.',
          impact: 'Possible impact.',
          confidence: 60,
        },
      });
      mockedWriteTransaction.mockResolvedValue({ records: [] });

      await generateNarrativeInsights('u1', { limit: 1 });

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.evidenceSummary).toContain('Strategy "AI 2025" <-[ALIGNS_WITH]- Technology "AI Agents"');
    });

    it('renders a generic projection with its source semantics and reversed direction', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [
          {
            ...chain,
            rel2: 'RELATED_TO',
            rel2SourceType: 'supplier_of',
            rel2StartId: 's2',
            rel2EndId: 't1',
          },
        ],
      });
      mockGenStructured.mockResolvedValue({
        insight: {
          title: 'Possible effect',
          narrative: 'A possible interpretation.',
          impact: 'Possible impact.',
          confidence: 60,
        },
      });
      mockedWriteTransaction.mockResolvedValue({ records: [] });

      await generateNarrativeInsights('u1', { limit: 1 });

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.evidenceSummary).toContain('Technology "AI Agents" <-[SUPPLIER_OF]- Strategy "Leadership"');
      expect(params.evidenceSummary).not.toContain('RELATED_TO');
      expect(params.relationshipTypes).toEqual(['ALIGNS_WITH', 'RELATED_TO']);
    });

    it('fails closed when returned edge endpoints do not match the evidence path', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [{ ...chain, rel1StartId: 'unrelated-a', rel1EndId: 'unrelated-b' }],
      });

      const n = await generateNarrativeInsights('u1', { limit: 1, recommendReports: true });

      expect(n).toBe(0);
      expect(mockGenStructured).not.toHaveBeenCalled();
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });

    it('rejects unsupported direct-action prose before persistence or recommendation', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [
          {
            ...chain,
            rel2: 'COMPETES_WITH',
            rel2SourceType: 'competes_with',
            rel2RelationId: 'rel-competes',
          },
        ],
      });
      mockGenStructured.mockResolvedValue({
        insight: {
          title: 'Guaranteed partnership',
          narrative: 'The companies will partner and adopt the platform.',
          impact: 'This guarantees revenue.',
          confidence: 99,
        },
      });
      mockedWriteTransaction.mockResolvedValue({ records: [] });

      const n = await generateNarrativeInsights('u1', { limit: 1, recommendReports: true });

      expect(n).toBe(0);
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
      expect(mockCreateProposedArtifact).not.toHaveBeenCalled();
    });

    it('preserves counter-evidence with bounded language and never promotes it to an observation', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [
          {
            ...chain,
            rel2: 'COMPETES_WITH',
            rel2SourceType: 'competes_with',
            rel2RelationId: 'rel-competes',
          },
        ],
      });
      mockGenStructured.mockResolvedValue({
        insight: {
          title: 'Competitive adjacency to assess',
          narrative: 'Competition may constrain the possible strategic fit; assess alternatives.',
          impact: 'Further research could test whether the adjacency merits attention.',
          confidence: 99,
        },
      });
      mockedWriteTransaction.mockResolvedValue({ records: [] });

      const n = await generateNarrativeInsights('u1', { limit: 1, recommendReports: true });

      expect(n).toBe(1);
      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.epistemicKind).toBe('inference');
      expect(params.hasCounterEvidence).toBe(true);
      expect(params.title).toBe('Hypothesis: Competitive adjacency to assess');
      expect(params.summary).toContain('Counter-evidence:');
      expect(params.summary).toContain('Inference (hypothesis):');
      expect(params.confidence).toBe(0.35);
      expect(mockCreateProposedArtifact).not.toHaveBeenCalled();
    });

    it('caps a narrative by the weakest edge and does not recommend a low-confidence report', async () => {
      mockedReadTransaction.mockResolvedValue({ records: [{ ...chain, rel2Confidence: 10 }] });
      mockGenStructured.mockResolvedValue({
        insight: {
          title: 'High model confidence',
          narrative: 'Possible interpretation.',
          impact: 'Possible impact.',
          confidence: 99,
        },
      });
      mockedWriteTransaction.mockResolvedValue({ records: [] });

      await generateNarrativeInsights('u1', { limit: 1, recommendReports: true });

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.confidence).toBe(0.1);
      expect(params.evidenceEdgeConfidences).toEqual([100, 10]);
      expect(mockCreateProposedArtifact).not.toHaveBeenCalled();
    });

    it('rejects invalid structured model output instead of persisting defaults', async () => {
      mockedReadTransaction.mockResolvedValue({ records: [chain] });
      mockGenStructured.mockImplementation(async (_prompt: string, schema: { parse: (value: unknown) => unknown }) =>
        schema.parse({
          insight: { title: '', narrative: '', impact: '', confidence: 'not-a-number' },
        })
      );

      const n = await generateNarrativeInsights('u1', { limit: 1 });

      expect(n).toBe(0);
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });

    it('refreshes the same evidence identity idempotently without resetting dismissal state', async () => {
      mockedReadTransaction.mockResolvedValue({ records: [chain] });
      mockGenStructured.mockResolvedValue({
        insight: {
          title: 'Adjacent theme',
          narrative: 'The path may indicate a theme worth investigating.',
          impact: 'Further research could assess its possible strategic relevance.',
          confidence: 70,
        },
      });
      mockedWriteTransaction.mockResolvedValue({ records: [] });

      await generateNarrativeInsights('u1', { limit: 1 });
      await generateNarrativeInsights('u1', { limit: 1 });

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(2);
      const [firstCypher, firstParams] = mockedWriteTransaction.mock.calls[0];
      const [, secondParams] = mockedWriteTransaction.mock.calls[1];
      expect(firstParams.id).toBe(secondParams.id);
      expect(firstCypher).toContain('MERGE (pi:ProactiveInsight { id: $id })');
      expect(firstCypher).toContain('ON MATCH SET pi.refreshedAt=$now');
      expect((firstCypher.match(/pi\.consumed=false/g) ?? []).length).toBe(1);
    });

    it('skips a chain whose synthesis fails (best-effort), never throwing', async () => {
      mockedReadTransaction.mockResolvedValue({ records: [chain] });
      mockGenStructured.mockRejectedValue(new Error('gemini down'));
      const n = await generateNarrativeInsights('u1', { limit: 1 });
      expect(n).toBe(0);
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });
  });
});
