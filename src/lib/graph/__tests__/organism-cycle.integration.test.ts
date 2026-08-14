/**
 * @file organism-cycle.integration.test.ts
 * @description Integration test for the full proactive intelligence organism cycle.
 *
 * Validates the data flow: session tracking -> agent observations ->
 * insight detection -> cross-session dot-connecting -> briefing API readiness.
 *
 * Uses a stateful Neo4j mock that tracks written nodes and edges,
 * allowing the full cycle to be verified without a running Neo4j instance.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

// ============================================================================
// STATEFUL GRAPH STATE
// ============================================================================

interface MockSession {
  id: string;
  userId: string;
  startedAt: string;
}

interface MockExploredEdge {
  sessionId: string;
  entityId: string;
  entityType: string;
  firstViewedAt: string;
  viewCount: number;
}

interface MockObservation {
  id: string;
  agentType: string;
  observationType: string;
  title: string;
  summary: string;
  confidence: number;
  entityId: string;
  entityName: string;
  entityType: string;
  timestamp: string;
}

interface MockInsight {
  id: string;
  userId: string;
  type: string;
  title: string;
  summary: string;
  agentName: string;
  confidenceScore: number;
  actionable: boolean;
  actionUrl: string;
  actionLabel: string;
  createdAt: string;
  consumed: boolean;
  consumedAt: string | null;
  /** Entity IDs this insight is ABOUT */
  aboutEntityIds: string[];
}

interface GraphState {
  sessions: MockSession[];
  exploredEdges: MockExploredEdge[];
  observations: MockObservation[];
  insights: MockInsight[];
}

const graphState: GraphState = {
  sessions: [],
  exploredEdges: [],
  observations: [],
  insights: [],
};

function resetGraphState(): void {
  graphState.sessions = [];
  graphState.exploredEdges = [];
  graphState.observations = [];
  graphState.insights = [];
}

// ============================================================================
// MOCK QUERY RESULT FACTORY
// ============================================================================

function createMockQueryResult<T>(records: T[], nodesCreated = 0) {
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

// ============================================================================
// STATEFUL MOCK IMPLEMENTATIONS
// ============================================================================

/**
 * Stateful mock for runWriteTransaction.
 * Pattern-matches on Cypher keywords to determine the operation,
 * stores data in graphState, and returns a mock result.
 */
function mockWriteImpl(cypher: string, params: Record<string, unknown>) {
  // Session creation: CREATE (s:Session ...
  if (cypher.includes('CREATE (s:Session')) {
    const session: MockSession = {
      id: params.id as string,
      userId: params.userId as string,
      startedAt: params.startedAt as string,
    };
    graphState.sessions.push(session);
    return Promise.resolve(
      createMockQueryResult([{ id: session.id, userId: session.userId, startedAt: session.startedAt }])
    );
  }

  // Entity view tracking: MERGE (s)-[r:EXPLORED]->(e)
  if (cypher.includes('EXPLORED')) {
    const existing = graphState.exploredEdges.find(
      (e) => e.sessionId === params.sessionId && e.entityId === params.entityId
    );
    if (existing) {
      existing.viewCount += 1;
    } else {
      graphState.exploredEdges.push({
        sessionId: params.sessionId as string,
        entityId: params.entityId as string,
        entityType: params.entityType as string,
        firstViewedAt: params.now as string,
        viewCount: 1,
      });
    }
    return Promise.resolve(createMockQueryResult([]));
  }

  // Agent observation: CREATE (obs:AgentObservation ...
  if (cypher.includes('CREATE (obs:AgentObservation')) {
    const obs: MockObservation = {
      id: params.id as string,
      agentType: params.agentType as string,
      observationType: params.observationType as string,
      title: params.title as string,
      summary: params.summary as string,
      confidence: params.confidence as number,
      entityId: params.entityId as string,
      entityName: params.entityName as string,
      entityType: params.entityType as string,
      timestamp: params.timestamp as string,
    };
    graphState.observations.push(obs);
    return Promise.resolve(
      createMockQueryResult([
        {
          id: obs.id,
          agentType: obs.agentType,
          observationType: obs.observationType,
          title: obs.title,
          summary: obs.summary,
          confidence: obs.confidence,
          entityId: obs.entityId,
          entityName: obs.entityName,
          entityType: obs.entityType,
          timestamp: obs.timestamp,
        },
      ])
    );
  }

  // ProactiveInsight upsert: deterministic MERGE makes replay idempotent.
  if (cypher.includes('MERGE (pi:ProactiveInsight')) {
    const aboutEntityIds: string[] = [];
    // Collect entity IDs from params
    if (params.entityId) aboutEntityIds.push(params.entityId as string);
    if (params.observedEntityId) aboutEntityIds.push(params.observedEntityId as string);
    if (params.exploredEntityId) aboutEntityIds.push(params.exploredEntityId as string);

    const insight: MockInsight = {
      id: params.id as string,
      userId: params.userId as string,
      type: (params.type as string) || 'connection',
      title: params.title as string,
      summary: params.summary as string,
      agentName: params.agentName as string,
      confidenceScore: (params.confidence as number) ?? (params.confidenceScore as number),
      actionable: true,
      actionUrl: params.actionUrl as string,
      actionLabel: params.actionLabel as string,
      createdAt: params.now as string,
      consumed: false,
      consumedAt: null,
      aboutEntityIds,
    };
    const existingIndex = graphState.insights.findIndex((item) => item.id === insight.id);
    const created = existingIndex < 0;
    if (existingIndex >= 0) {
      graphState.insights[existingIndex] = {
        ...graphState.insights[existingIndex],
        ...insight,
        createdAt: graphState.insights[existingIndex].createdAt,
        consumed: graphState.insights[existingIndex].consumed,
        consumedAt: graphState.insights[existingIndex].consumedAt,
      };
    } else {
      graphState.insights.push(insight);
    }
    return Promise.resolve(createMockQueryResult([], created ? 1 : 0));
  }

  // markInsightConsumed: SET pi.consumed = true
  if (cypher.includes('pi.consumed = true')) {
    const insightToConsume = graphState.insights.find((i) => i.id === params.id);
    if (insightToConsume) {
      insightToConsume.consumed = true;
      insightToConsume.consumedAt = params.now as string;
    }
    return Promise.resolve(createMockQueryResult([]));
  }

  // Fallback
  return Promise.resolve(createMockQueryResult([]));
}

/**
 * Stateful mock for runReadTransaction.
 * Pattern-matches on Cypher keywords to determine the query,
 * reads from graphState, and returns matching records.
 */
function mockReadImpl(cypher: string, params: Record<string, unknown>) {
  // Active session lookup: MATCH (s:Session { userId: $userId }) WHERE s.startedAt > $cutoff
  if (
    cypher.includes('MATCH (s:Session { userId: $userId })') &&
    cypher.includes('s.startedAt > $cutoff') &&
    cypher.includes('LIMIT 1')
  ) {
    const cutoff = params.cutoff as string;
    const userId = params.userId as string;
    const match = graphState.sessions
      .filter((s) => s.userId === userId && s.startedAt > cutoff)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (match.length > 0) {
      return Promise.resolve(
        createMockQueryResult([{ id: match[0].id, userId: match[0].userId, startedAt: match[0].startedAt }])
      );
    }
    return Promise.resolve(createMockQueryResult([]));
  }

  // Explored entities: MATCH (s:Session { userId: $userId })-[r:EXPLORED]->(e) ... ORDER BY lastViewedAt DESC
  if (
    cypher.includes('MATCH (s:Session { userId: $userId })-[r:EXPLORED]->(e)') &&
    cypher.includes('sum(r.viewCount) AS viewCount')
  ) {
    const userId = params.userId as string;
    const userSessionIds = graphState.sessions.filter((s) => s.userId === userId).map((s) => s.id);

    // Aggregate explored edges by entityId
    const entityMap = new Map<string, { entityType: string; viewCount: number; lastViewedAt: string }>();
    for (const edge of graphState.exploredEdges) {
      if (!userSessionIds.includes(edge.sessionId)) continue;
      const existing = entityMap.get(edge.entityId);
      if (existing) {
        existing.viewCount += edge.viewCount;
        if (edge.firstViewedAt > existing.lastViewedAt) {
          existing.lastViewedAt = edge.firstViewedAt;
        }
      } else {
        entityMap.set(edge.entityId, {
          entityType: edge.entityType,
          viewCount: edge.viewCount,
          lastViewedAt: edge.firstViewedAt,
        });
      }
    }

    const records = Array.from(entityMap.entries()).map(([entityId, data]) => ({
      entityId,
      entityType: data.entityType,
      name: entityId, // Simplified: use entityId as name
      viewCount: data.viewCount,
      lastViewedAt: data.lastViewedAt,
    }));

    return Promise.resolve(createMockQueryResult(records));
  }

  // Session history: MATCH (s:Session { userId: $userId }) OPTIONAL MATCH (s)-[r:EXPLORED]->()
  if (
    cypher.includes('MATCH (s:Session { userId: $userId })') &&
    cypher.includes('OPTIONAL MATCH (s)-[r:EXPLORED]->()')
  ) {
    const userId = params.userId as string;
    const records = graphState.sessions
      .filter((s) => s.userId === userId)
      .map((s) => ({
        sessionId: s.id,
        startedAt: s.startedAt,
        entityCount: graphState.exploredEdges.filter((e) => e.sessionId === s.id).length,
      }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return Promise.resolve(createMockQueryResult(records));
  }

  // Insight detection: observations about explored entities
  if (cypher.includes('MATCH (s:Session { userId: $userId })-[:EXPLORED]->(e)<-[:ABOUT]-(obs:AgentObservation)')) {
    const userId = params.userId as string;
    const userSessionIds = graphState.sessions.filter((s) => s.userId === userId).map((s) => s.id);

    // Get explored entity IDs
    const exploredEntityIds = new Set(
      graphState.exploredEdges.filter((e) => userSessionIds.includes(e.sessionId)).map((e) => e.entityId)
    );

    // Find observations about those entities
    const matchedObs = graphState.observations
      .filter((obs) => exploredEntityIds.has(obs.entityId))
      .map((obs) => ({
        obsId: obs.id,
        type: obs.observationType,
        title: obs.title,
        summary: obs.summary,
        agentName: obs.agentType,
        confidence: obs.confidence,
        entityId: obs.entityId,
        entityName: obs.entityName,
        entityType: obs.entityType,
        timestamp: obs.timestamp,
      }));

    return Promise.resolve(createMockQueryResult(matchedObs));
  }

  // Get insights for user: MATCH (pi:ProactiveInsight { userId: $userId, consumed: false })
  if (
    cypher.includes('MATCH (pi:ProactiveInsight { userId: $userId, consumed: false })') &&
    cypher.includes('OPTIONAL MATCH (pi)-[:ABOUT]->(e)')
  ) {
    const userId = params.userId as string;
    // params.limit may be a neo4j.int() object ({ high, low }) or a plain number
    const rawLimit = params.limit;
    const limit =
      typeof rawLimit === 'object' && rawLimit !== null && 'low' in (rawLimit as Record<string, unknown>)
        ? (rawLimit as { low: number }).low
        : (rawLimit as number) || 20;
    const unconsumedInsights = graphState.insights
      .filter((i) => i.userId === userId && !i.consumed)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

    const records = unconsumedInsights.map((insight) => ({
      id: insight.id,
      type: insight.type,
      title: insight.title,
      summary: insight.summary,
      agentName: insight.agentName,
      confidenceScore: insight.confidenceScore,
      actionable: insight.actionable,
      actionUrl: insight.actionUrl,
      actionLabel: insight.actionLabel,
      createdAt: insight.createdAt,
      liked: false,
      entities: insight.aboutEntityIds.map((eid) => {
        // Try to find entity name from observations or use the ID
        const obs = graphState.observations.find((o) => o.entityId === eid);
        return {
          id: eid,
          name: obs?.entityName || eid,
          type: obs?.entityType || 'unknown',
        };
      }),
    }));

    return Promise.resolve(createMockQueryResult(records));
  }

  // Observation lookup for dot-connector: MATCH (obs:AgentObservation { id: $observationId })
  if (cypher.includes('MATCH (obs:AgentObservation { id: $observationId })')) {
    const observationId = params.observationId as string;
    const obs = graphState.observations.find((o) => o.id === observationId);
    if (obs) {
      return Promise.resolve(
        createMockQueryResult([
          {
            entityId: obs.entityId,
            title: obs.title,
            summary: obs.summary,
            type: obs.observationType,
            agentName: obs.agentType,
            confidence: obs.confidence,
          },
        ])
      );
    }
    return Promise.resolve(createMockQueryResult([]));
  }

  // Dot connections (shortestPath): find paths between observed and explored entities
  if (cypher.includes('shortestPath')) {
    const entityId = params.entityId as string;
    const userId = params.userId as string;
    const userSessionIds = graphState.sessions.filter((s) => s.userId === userId).map((s) => s.id);

    // Find explored entities that are different from the target
    const exploredEntities = graphState.exploredEdges.filter(
      (e) => userSessionIds.includes(e.sessionId) && e.entityId !== entityId
    );

    // Simulate short paths from the observed entity to explored entities
    const records = exploredEntities.map((explored) => {
      const obs = graphState.observations.find((o) => o.entityId === entityId);
      return {
        observedEntityId: entityId,
        observedEntityName: obs?.entityName || entityId,
        observedEntityType: obs?.entityType || 'unknown',
        exploredEntityId: explored.entityId,
        exploredEntityName: explored.entityId, // Simplified
        exploredEntityType: explored.entityType,
        pathLength: 1,
        relationshipTypes: ['RELATED_TO'],
        sourceRelationTypes: ['related_to'],
        relationIds: [`rel-${entityId}-${explored.entityId}`],
        assertedBy: ['user:user-123'],
        claimStatuses: ['curated'],
        edgeConfidences: [100],
        pathNodeIds: [entityId, explored.entityId],
        pathNodeNames: [obs?.entityName || entityId, explored.entityId],
        pathNodeTypes: [obs?.entityType || 'unknown', explored.entityType],
        relationshipStartIds: [entityId],
        relationshipEndIds: [explored.entityId],
      };
    });

    return Promise.resolve(createMockQueryResult(records));
  }

  // Recent dot connections query
  if (cypher.includes("type: 'connection', consumed: false") && cypher.includes('size(entities) >= 2')) {
    const userId = params.userId as string;
    // params.limit may be a neo4j.int() object ({ high, low }) or a plain number
    const rawLimit2 = params.limit;
    const limit =
      typeof rawLimit2 === 'object' && rawLimit2 !== null && 'low' in (rawLimit2 as Record<string, unknown>)
        ? (rawLimit2 as { low: number }).low
        : (rawLimit2 as number) || 10;
    const connectionInsights = graphState.insights
      .filter((i) => i.userId === userId && i.type === 'connection' && !i.consumed && i.aboutEntityIds.length >= 2)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

    const records = connectionInsights.map((insight) => ({
      pi: {
        id: insight.id,
        title: insight.title,
        summary: insight.summary,
        createdAt: insight.createdAt,
      },
      entities: insight.aboutEntityIds.map((eid) => {
        const obs = graphState.observations.find((o) => o.entityId === eid);
        return {
          id: eid,
          name: obs?.entityName || eid,
          type: obs?.entityType || 'unknown',
        };
      }),
    }));

    return Promise.resolve(createMockQueryResult(records));
  }

  // Fallback
  return Promise.resolve(createMockQueryResult([]));
}

// ============================================================================
// MOCKS (must be before imports)
// ============================================================================

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

// Mock crypto.randomUUID with incrementing counter
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

import * as neo4jClient from '../neo4j-client';
import { createSession, getOrCreateActiveSession, trackEntityView, getExploredEntities } from '../session-memory';
import {
  recordAgentObservation,
  detectInsightsForUser,
  getInsightsForUser,
  markInsightConsumed,
} from '../proactive-insights';
import { findDotConnections, connectDots } from '../dot-connector';

const mockedWriteTransaction = neo4jClient.runWriteTransaction as jest.Mock;
const mockedReadTransaction = neo4jClient.runReadTransaction as jest.Mock;

// ============================================================================
// TESTS
// ============================================================================

describe('Organism Cycle Integration', () => {
  beforeEach(() => {
    resetGraphState();
    jest.clearAllMocks();
    uuidCounter = 0;

    // Wire up the stateful mocks
    mockedWriteTransaction.mockImplementation(mockWriteImpl);
    mockedReadTransaction.mockImplementation(mockReadImpl);
  });

  // --------------------------------------------------------------------------
  // Step 1: Session Tracking
  // --------------------------------------------------------------------------

  describe('Step 1: Session Tracking', () => {
    it('creates a session and tracks entity exploration', async () => {
      // 1. Create a session for user
      const session = await createSession('user-123');
      expect(session.id).toBeDefined();
      expect(session.userId).toBe('user-123');
      expect(graphState.sessions).toHaveLength(1);

      // 2. Track entity views
      await trackEntityView(session.id, 'tech-wasm', 'technology');
      await trackEntityView(session.id, 'comp-openai', 'company');

      expect(graphState.exploredEdges).toHaveLength(2);

      // 3. Verify explored entities are recorded
      const explored = await getExploredEntities('user-123');
      expect(explored).toHaveLength(2);
      expect(explored.map((e) => e.entityId)).toContain('tech-wasm');
      expect(explored.map((e) => e.entityId)).toContain('comp-openai');
    });

    it('reuses an active session via getOrCreateActiveSession', async () => {
      // Create a session
      const session1 = await createSession('user-123');
      expect(graphState.sessions).toHaveLength(1);

      // getOrCreateActiveSession should find it (within 30-min window)
      const session2 = await getOrCreateActiveSession('user-123');
      expect(session2.id).toBe(session1.id);
      // No new session should have been created
      expect(graphState.sessions).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Step 2: Agent Observations
  // --------------------------------------------------------------------------

  describe('Step 2: Agent Observations', () => {
    it('records agent observations about entities', async () => {
      const obs = await recordAgentObservation({
        agentType: 'Scout',
        observationType: 'discovery',
        title: 'Scout found new WebAssembly use case',
        summary: 'Production deployment of WASM in edge computing',
        confidence: 0.85,
        entityId: 'tech-wasm',
        entityName: 'WebAssembly',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      expect(obs.id).toBeDefined();
      expect(obs.agentType).toBe('Scout');
      expect(obs.confidence).toBe(0.85);

      // Verify stored in graph state
      expect(graphState.observations).toHaveLength(1);
      expect(graphState.observations[0].entityId).toBe('tech-wasm');
    });

    it('records multiple observations from different agents', async () => {
      await recordAgentObservation({
        agentType: 'Scout',
        observationType: 'discovery',
        title: 'New WASM use case',
        summary: 'Edge deployment found',
        confidence: 0.85,
        entityId: 'tech-wasm',
        entityName: 'WebAssembly',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      await recordAgentObservation({
        agentType: 'Evaluator',
        observationType: 'scoring_change',
        title: 'WASM maturity increased',
        summary: 'Evidence supports Trial ring',
        confidence: 0.9,
        entityId: 'tech-wasm',
        entityName: 'WebAssembly',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      expect(graphState.observations).toHaveLength(2);
      expect(graphState.observations[0].agentType).toBe('Scout');
      expect(graphState.observations[1].agentType).toBe('Evaluator');
    });
  });

  // --------------------------------------------------------------------------
  // Step 3: Proactive Insight Detection
  // --------------------------------------------------------------------------

  describe('Step 3: Proactive Insight Detection', () => {
    it('detects insights when observations match explored entities', async () => {
      // Setup: user explored WebAssembly
      const session = await createSession('user-123');
      await trackEntityView(session.id, 'tech-wasm', 'technology');

      // Agent recorded an observation about WebAssembly
      await recordAgentObservation({
        agentType: 'Scout',
        observationType: 'discovery',
        title: 'Scout found new WASM use case',
        summary: 'Production deployment of WASM in edge computing',
        confidence: 0.85,
        entityId: 'tech-wasm',
        entityName: 'WebAssembly',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      // Run detection
      const result = await detectInsightsForUser('user-123');

      expect(result.userId).toBe('user-123');
      expect(result.observationsMatched).toBe(1);
      expect(result.insightsCreated).toBe(1);

      // Verify insight was stored in graph state
      expect(graphState.insights).toHaveLength(1);
      expect(graphState.insights[0].userId).toBe('user-123');
      expect(graphState.insights[0].agentName).toBe('Scout');
    });

    it('returns zero when no observations match explored entities', async () => {
      // User explored WebAssembly
      const session = await createSession('user-123');
      await trackEntityView(session.id, 'tech-wasm', 'technology');

      // Agent observed a different entity (Rust)
      await recordAgentObservation({
        agentType: 'Scout',
        observationType: 'discovery',
        title: 'Rust update',
        summary: 'Rust news',
        confidence: 0.8,
        entityId: 'tech-rust',
        entityName: 'Rust',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      const result = await detectInsightsForUser('user-123');

      expect(result.observationsMatched).toBe(0);
      expect(result.insightsCreated).toBe(0);
      expect(graphState.insights).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Step 4: Cross-Session Dot-Connecting
  // --------------------------------------------------------------------------

  describe('Step 4: Cross-Session Dot-Connecting', () => {
    it('finds connections between observations and past explorations', async () => {
      // User explored a company
      const session = await createSession('user-123');
      await trackEntityView(session.id, 'comp-openai', 'company');

      // Agent observed a technology connected to that company
      await recordAgentObservation({
        agentType: 'Scout',
        observationType: 'discovery',
        title: 'GPT-5 announced',
        summary: 'OpenAI released GPT-5',
        confidence: 0.95,
        entityId: 'tech-gpt5',
        entityName: 'GPT-5',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      const connections = await findDotConnections('tech-gpt5', 'user-123');

      expect(Array.isArray(connections)).toBe(true);
      expect(connections.length).toBeGreaterThanOrEqual(1);
      expect(connections[0].observedEntityId).toBe('tech-gpt5');
      expect(connections[0].exploredEntityId).toBe('comp-openai');
      expect(typeof connections[0].relevanceScore).toBe('number');
      expect(connections[0].relevanceScore).toBeGreaterThan(0);
    });

    it('connectDots creates insights for high-relevance connections', async () => {
      // User explored a company
      const session = await createSession('user-123');
      await trackEntityView(session.id, 'comp-anthropic', 'company');

      // Agent created an observation
      const obs = await recordAgentObservation({
        agentType: 'Evaluator',
        observationType: 'connection',
        title: 'Claude Opus 4 released',
        summary: 'Anthropic released a new frontier model',
        confidence: 0.92,
        entityId: 'tech-claude',
        entityName: 'Claude Opus 4',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      // connectDots orchestrates the full flow
      const result = await connectDots(obs.id, 'user-123');

      expect(result.userId).toBe('user-123');
      expect(result.observationId).toBe(obs.id);
      expect(result.connections.length).toBeGreaterThanOrEqual(1);
      // Path length 1 => relevance 0.5 >= 0.3 threshold, so insight created
      expect(result.insightsCreated).toBeGreaterThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // Step 5: Briefing Readiness
  // --------------------------------------------------------------------------

  describe('Step 5: Briefing Readiness', () => {
    it('returns insights formatted for the briefing feed', async () => {
      // Setup: full path from session -> observation -> detection -> insight
      const session = await createSession('user-123');
      await trackEntityView(session.id, 'tech-wasm', 'technology');

      await recordAgentObservation({
        agentType: 'Scout',
        observationType: 'discovery',
        title: 'New WASM runtime',
        summary: 'Wasmer 5.0 released with SIMD support',
        confidence: 0.88,
        entityId: 'tech-wasm',
        entityName: 'WebAssembly',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      await detectInsightsForUser('user-123');

      // Query insights for the briefing page
      const insights = await getInsightsForUser('user-123');
      expect(Array.isArray(insights)).toBe(true);
      expect(insights.length).toBeGreaterThanOrEqual(1);

      // Each insight should have the fields the BriefingFeed expects
      const insight = insights[0];
      expect(insight).toHaveProperty('id');
      expect(insight).toHaveProperty('type');
      expect(insight).toHaveProperty('title');
      expect(insight).toHaveProperty('summary');
      expect(insight).toHaveProperty('agentName');
      expect(insight).toHaveProperty('confidenceScore');
      expect(insight).toHaveProperty('actionable');
      expect(insight).toHaveProperty('createdAt');
      expect(insight).toHaveProperty('relatedEntities');
      expect(insight.consumed).toBe(false);
    });

    it('marks insights as consumed after user views them', async () => {
      // Create a full insight chain
      const session = await createSession('user-123');
      await trackEntityView(session.id, 'tech-wasm', 'technology');

      await recordAgentObservation({
        agentType: 'Scout',
        observationType: 'discovery',
        title: 'WASM update',
        summary: 'Update details',
        confidence: 0.8,
        entityId: 'tech-wasm',
        entityName: 'WebAssembly',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      await detectInsightsForUser('user-123');

      // Verify insight exists and is unconsumed
      expect(graphState.insights).toHaveLength(1);
      expect(graphState.insights[0].consumed).toBe(false);

      // Simulate user viewing the insight
      await markInsightConsumed(graphState.insights[0].id, 'user-123');

      // Verify the consumed flag was set
      expect(graphState.insights[0].consumed).toBe(true);
      expect(graphState.insights[0].consumedAt).toBeDefined();

      // getInsightsForUser should now return empty (consumed insights are filtered)
      const remainingInsights = await getInsightsForUser('user-123');
      expect(remainingInsights).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Full Cycle
  // --------------------------------------------------------------------------

  describe('Full Cycle', () => {
    it('completes the entire organism cycle end-to-end', async () => {
      // ================================================================
      // Phase 1: User browses entities (session tracking)
      // ================================================================
      const session = await createSession('user-456');
      await trackEntityView(session.id, 'tech-rust', 'technology');
      await trackEntityView(session.id, 'comp-anthropic', 'company');

      // Verify session state
      expect(graphState.sessions).toHaveLength(1);
      expect(graphState.exploredEdges).toHaveLength(2);

      const explored = await getExploredEntities('user-456');
      expect(explored).toHaveLength(2);

      // ================================================================
      // Phase 2: Agent runs a sweep and creates observations
      // ================================================================
      const obs = await recordAgentObservation({
        agentType: 'Evaluator',
        observationType: 'scoring_change',
        title: 'Rust moved to Trial ring',
        summary: 'New production evidence for Rust in systems programming',
        confidence: 0.9,
        entityId: 'tech-rust',
        entityName: 'Rust',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      expect(obs.id).toBeDefined();
      expect(graphState.observations).toHaveLength(1);

      // ================================================================
      // Phase 3: Insight detection runs (in REFLECT step)
      // ================================================================
      const detection = await detectInsightsForUser('user-456');
      expect(detection.userId).toBe('user-456');
      expect(detection.observationsMatched).toBe(1);
      expect(detection.insightsCreated).toBe(1);

      // ================================================================
      // Phase 4: User opens Briefing page
      // ================================================================
      const insights = await getInsightsForUser('user-456');
      expect(Array.isArray(insights)).toBe(true);
      expect(insights.length).toBe(1);

      const briefingItem = insights[0];
      expect(briefingItem.type).toBe('scoring_change');
      expect(briefingItem.agentName).toBe('Evaluator');
      expect(briefingItem.title).toBe('Source observation: Rust moved to Trial ring');
      expect(briefingItem.consumed).toBe(false);
      expect(briefingItem.actionable).toBe(true);

      // ================================================================
      // Phase 5: User consumes the insight
      // ================================================================
      await markInsightConsumed(briefingItem.id, 'user-456');

      // Verify consumed
      const afterConsume = await getInsightsForUser('user-456');
      expect(afterConsume).toHaveLength(0);

      // Verify the state is consistent
      expect(graphState.insights[0].consumed).toBe(true);
      expect(graphState.insights[0].consumedAt).not.toBeNull();

      // The cycle is complete!
    });

    it('handles multiple users with independent insight streams', async () => {
      // User A explores tech-wasm
      const sessionA = await createSession('user-A');
      await trackEntityView(sessionA.id, 'tech-wasm', 'technology');

      // User B explores tech-rust
      const sessionB = await createSession('user-B');
      await trackEntityView(sessionB.id, 'tech-rust', 'technology');

      // Agent creates observations about both
      await recordAgentObservation({
        agentType: 'Scout',
        observationType: 'discovery',
        title: 'WASM update',
        summary: 'New WASM runtime',
        confidence: 0.85,
        entityId: 'tech-wasm',
        entityName: 'WebAssembly',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      await recordAgentObservation({
        agentType: 'Evaluator',
        observationType: 'scoring_change',
        title: 'Rust update',
        summary: 'Rust maturity changed',
        confidence: 0.9,
        entityId: 'tech-rust',
        entityName: 'Rust',
        entityType: 'technology',
        timestamp: new Date().toISOString(),
      });

      // Detect insights for each user independently
      const detectionA = await detectInsightsForUser('user-A');
      const detectionB = await detectInsightsForUser('user-B');

      // User A should only see WASM insights
      expect(detectionA.observationsMatched).toBe(1);
      expect(detectionA.insightsCreated).toBe(1);

      // User B should only see Rust insights
      expect(detectionB.observationsMatched).toBe(1);
      expect(detectionB.insightsCreated).toBe(1);

      // Verify isolation: each user sees only their own insights
      const insightsA = await getInsightsForUser('user-A');
      const insightsB = await getInsightsForUser('user-B');

      expect(insightsA).toHaveLength(1);
      expect(insightsA[0].title).toBe('Source observation: WASM update');

      expect(insightsB).toHaveLength(1);
      expect(insightsB[0].title).toBe('Source observation: Rust update');
    });
  });
});
