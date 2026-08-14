/**
 * GRAPH-062 — strategy-to-technology alignment must be a chain of asserted
 * business facts between canonical entities, not behavioral proximity.
 *
 * The live TEST-027 finding was that investment scoring accepted
 * `Strategy <-EXPLORED- Session -EXPLORED-> Technology` as strategic alignment:
 * two users' browsing trails crossing, scored at 100% and weighted 40% of the
 * recommendation. These tests pin the traversal envelope the query now sends and
 * the receipt it now returns; the disposable-Neo4j fixture in
 * `graph-trust-boundaries.integration.test.ts` proves the envelope actually
 * excludes such a path in a real graph.
 *
 * @jest-environment node
 */

import type { GraphNode, TraversalOptions } from '../interface';

const STRATEGY_ID = 'strategy-alignment-1';

const techNode = (id: string): GraphNode => ({
  id,
  labels: ['Entity', 'Technology'],
  properties: { name: id, entityType: 'technology' },
});

const strategyNode = (): GraphNode => ({
  id: STRATEGY_ID,
  labels: ['Entity', 'Strategy'],
  properties: { name: 'Grow the platform', entityType: 'strategy' },
});

function relation(type: string, sourceId: string, targetId: string, properties: Record<string, unknown> = {}) {
  return { id: `${sourceId}->${targetId}`, type, sourceId, targetId, properties };
}

const findConnectedCalls: Array<{ nodeId: string; targetType: string; options: TraversalOptions }> = [];
const findPathCalls: Array<{ fromId: string; toId: string; options: TraversalOptions }> = [];
const paths = new Map<
  string,
  { nodes: GraphNode[]; relations: ReturnType<typeof relation>[]; length: number } | null
>();
let connectedTechnologies: GraphNode[] = [];

const stubService = {
  getNode: jest.fn(async (id: string) => (id === STRATEGY_ID ? strategyNode() : techNode(id))),
  getNodes: jest.fn(async () => []),
  getNeighbors: jest.fn(async () => []),
  findConnected: jest.fn(async (nodeId: string, targetType: string, options: TraversalOptions = {}) => {
    findConnectedCalls.push({ nodeId, targetType, options });
    return connectedTechnologies;
  }),
  findPath: jest.fn(async (fromId: string, toId: string, options: TraversalOptions = {}) => {
    findPathCalls.push({ fromId, toId, options });
    return paths.get(fromId) ?? null;
  }),
  query: jest.fn(async () => ({ records: [], summary: {} })),
};

jest.mock('../service-factory', () => ({
  getGraphService: jest.fn(async () => stubService),
}));

// The path cache is keyed by the full options object; without clearing it
// between cases a second scenario would read the first one's path.
import { pathCache } from '../query-cache';
import { BUSINESS_ENTITY_GRAPH_LABELS } from '../entity-type-vocab';
import { CLAIM_RELATION_PREDICATES } from '../relation-registry';
import { findTechnologiesForStrategy, recommendTechnologyInvestments } from '../business-queries';

beforeEach(() => {
  findConnectedCalls.length = 0;
  findPathCalls.length = 0;
  paths.clear();
  connectedTechnologies = [];
  pathCache.clear();
  jest.clearAllMocks();
});

describe('findTechnologiesForStrategy traversal envelope', () => {
  it('constrains discovery and pathfinding to asserted business predicates', async () => {
    connectedTechnologies = [];

    await findTechnologiesForStrategy(STRATEGY_ID);

    expect(findConnectedCalls).toHaveLength(1);
    expect(findConnectedCalls[0].options.relationTypes).toEqual(CLAIM_RELATION_PREDICATES);
    // EXPLORED is a Session's browsing trail and has no entry in
    // RELATION_PREDICATE_MAP, so deriving the allowlist excludes it by
    // construction rather than by a hand-maintained denylist.
    expect(findConnectedCalls[0].options.relationTypes).not.toContain('EXPLORED');
    expect(findConnectedCalls[0].options.relationTypes).toContain('ALIGNS_WITH');
    // The drifted copy in dot-connector.ts omitted EVALUATES; the derived list
    // must carry it.
    expect(findConnectedCalls[0].options.relationTypes).toContain('EVALUATES');
  });

  it('requires a canonical business entity label at every hop', async () => {
    connectedTechnologies = [techNode('tech-a')];
    paths.set('tech-a', {
      nodes: [techNode('tech-a'), strategyNode()],
      relations: [relation('ALIGNS_WITH', 'tech-a', STRATEGY_ID, { effectiveConfidence: 100 })],
      length: 1,
    });

    await findTechnologiesForStrategy(STRATEGY_ID);

    for (const call of [...findConnectedCalls, ...findPathCalls]) {
      expect(call.options.nodeLabels).toEqual(BUSINESS_ENTITY_GRAPH_LABELS);
      expect(call.options.nodeLabels).not.toContain('Session');
      expect(call.options.nodeLabels).not.toContain('Entity');
    }
  });

  it('cannot be widened by a caller passing its own relation types or labels', async () => {
    connectedTechnologies = [];

    await findTechnologiesForStrategy(STRATEGY_ID, {
      relationTypes: ['EXPLORED'],
      nodeLabels: ['Session'],
    } as TraversalOptions);

    expect(findConnectedCalls[0].options.relationTypes).toEqual(CLAIM_RELATION_PREDICATES);
    expect(findConnectedCalls[0].options.nodeLabels).toEqual(BUSINESS_ENTITY_GRAPH_LABELS);
  });

  it('still honours a caller-supplied depth', async () => {
    connectedTechnologies = [];

    await findTechnologiesForStrategy(STRATEGY_ID, { maxDepth: 2 });

    expect(findConnectedCalls[0].options.maxDepth).toBe(2);
  });
});

describe('findTechnologiesForStrategy receipt', () => {
  it('returns the admitted predicate chain, strategy-end first', async () => {
    connectedTechnologies = [techNode('tech-chain')];
    // technology -[:ENABLES]-> useCase -[:SUPPORTS]-> strategy, as findPath
    // returns it (technology end first).
    paths.set('tech-chain', {
      nodes: [
        techNode('tech-chain'),
        { id: 'uc-1', labels: ['Entity', 'UseCase'], properties: { entityType: 'useCase' } },
        strategyNode(),
      ],
      relations: [
        relation('ENABLES', 'tech-chain', 'uc-1', { effectiveConfidence: 100 }),
        relation('SUPPORTS', 'uc-1', STRATEGY_ID, { effectiveConfidence: 100 }),
      ],
      length: 2,
    });

    const [aligned] = await findTechnologiesForStrategy(STRATEGY_ID);

    expect(aligned.admittedPath).toEqual(['SUPPORTS', 'ENABLES']);
    expect(aligned.distance).toBe(2);
    expect(aligned.alignmentScore).toBe(100);
  });

  it('drops a technology whose business path cannot be resolved', async () => {
    // Reachable by the discovery query but with no admitted path — previously
    // scored 100 and labelled "indirectly connected".
    connectedTechnologies = [techNode('tech-unreachable')];
    paths.set('tech-unreachable', null);

    await expect(findTechnologiesForStrategy(STRATEGY_ID)).resolves.toEqual([]);
  });

  it('drops a zero-length path rather than crediting a self-match', async () => {
    connectedTechnologies = [techNode('tech-empty')];
    paths.set('tech-empty', { nodes: [techNode('tech-empty')], relations: [], length: 0 });

    await expect(findTechnologiesForStrategy(STRATEGY_ID)).resolves.toEqual([]);
  });

  it('ranks a high-confidence direct alignment above a decayed indirect one', async () => {
    connectedTechnologies = [techNode('tech-direct'), techNode('tech-weak')];
    paths.set('tech-direct', {
      nodes: [techNode('tech-direct'), strategyNode()],
      relations: [relation('ALIGNS_WITH', 'tech-direct', STRATEGY_ID, { effectiveConfidence: 95 })],
      length: 1,
    });
    paths.set('tech-weak', {
      nodes: [
        techNode('tech-weak'),
        { id: 'uc-2', labels: ['Entity', 'UseCase'], properties: { entityType: 'useCase' } },
        strategyNode(),
      ],
      relations: [
        relation('ENABLES', 'tech-weak', 'uc-2', { effectiveConfidence: 40 }),
        relation('SUPPORTS', 'uc-2', STRATEGY_ID, { effectiveConfidence: 50 }),
      ],
      length: 2,
    });

    const results = await findTechnologiesForStrategy(STRATEGY_ID);

    expect(results.map((r) => r.technology.id)).toEqual(['tech-direct', 'tech-weak']);
    expect(results[0].alignmentScore).toBe(95);
    expect(results[1].alignmentScore).toBe(20);
  });
});

describe('recommendTechnologyInvestments receipt', () => {
  it('names the admitted path in the reason and exposes it structurally', async () => {
    connectedTechnologies = [techNode('tech-receipt')];
    paths.set('tech-receipt', {
      nodes: [techNode('tech-receipt'), strategyNode()],
      relations: [relation('ALIGNS_WITH', 'tech-receipt', STRATEGY_ID, { effectiveConfidence: 100 })],
      length: 1,
    });

    const [recommendation] = await recommendTechnologyInvestments({ strategyId: STRATEGY_ID });

    expect(recommendation.strategyAlignmentPath).toEqual(['ALIGNS_WITH']);
    expect(recommendation.reasons).toEqual(['Aligns with strategy (100%) via ALIGNS_WITH']);
    expect(recommendation.score).toBeCloseTo(40);
  });

  it('recommends nothing from strategy alignment when only proximity exists', async () => {
    connectedTechnologies = [techNode('tech-coview')];
    paths.set('tech-coview', null);

    await expect(recommendTechnologyInvestments({ strategyId: STRATEGY_ID })).resolves.toEqual([]);
  });
});
