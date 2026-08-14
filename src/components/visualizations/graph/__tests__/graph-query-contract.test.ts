/** @jest-environment node */

import {
  DEFAULT_GRAPH_QUERY,
  DOMAIN_LABEL_LIST_LITERAL,
  EXPAND_GRAPH_NEIGHBORS_QUERY,
  GRAPH_EXPANSION_PAGE_SIZE,
  getVisibleNeighborRelationshipIds,
  isGraphAtExpansionLimit,
  mergeGraphExpansionPage,
  selectGraphExpansionPage,
} from '@/app/visualizations/graph/queries';
import { GRAPH_QUERY_LIMITS } from '@/lib/graph-query-limits';
import { currentEdgePredicate } from '@/lib/graph-query-current';
import { RAW_CYPHER_LIMITS, inspectCypherReadQuery } from '@/lib/graph/cypher-read-policy';
import { DOMAIN_NODE_LABELS, partitionGraphView } from '../graph-view-model';
import { TEMPLATES } from '../QueryTemplates';

const CURRENT_EDGE_CLAUSES = ['t_invalidated IS NULL', "claimStatus, 'curated'", "<> 'rejected'"];

function expectCurrentGraphQuery(query: string): void {
  for (const clause of CURRENT_EDGE_CLAUSES) expect(query).toContain(clause);
}

describe('Graph Explorer current-fact query contract', () => {
  it('filters the initial graph and deterministically pages neighbor expansion', () => {
    expectCurrentGraphQuery(DEFAULT_GRAPH_QUERY);
    expectCurrentGraphQuery(EXPAND_GRAPH_NEIGHBORS_QUERY);
    expect(EXPAND_GRAPH_NEIGHBORS_QUERY).toContain('(elementId(n) = $nodeId OR n.id = $nodeId)');
    expect(EXPAND_GRAPH_NEIGHBORS_QUERY).toContain('NOT elementId(r) IN $excludedRelationshipIds');
    expect(EXPAND_GRAPH_NEIGHBORS_QUERY).toContain(`LIMIT ${GRAPH_EXPANSION_PAGE_SIZE + 1}`);
    expect(EXPAND_GRAPH_NEIGHBORS_QUERY.indexOf('ORDER BY elementId(r)')).toBeLessThan(
      EXPAND_GRAPH_NEIGHBORS_QUERY.indexOf('LIMIT')
    );
  });

  it('filters every relationship or path preset while leaving node-only presets available', () => {
    const relationshipTemplateIds = [
      'all-relationships',
      'companies-technologies',
      'use-cases',
      'org-structure',
      'shortest-path',
      'connected-entities',
      'most-connected',
      'documents',
    ];

    for (const id of relationshipTemplateIds) {
      const template = TEMPLATES.find((candidate) => candidate.id === id);
      expect(template).toBeDefined();
      expectCurrentGraphQuery(template!.query);
    }
    expect(TEMPLATES.find((template) => template.id === 'all-nodes')?.query).not.toContain('t_invalidated');
    expect(TEMPLATES.find((template) => template.id === 'technologies')?.query).not.toContain('t_invalidated');
  });
});

describe('GRAPH-071 first-run default query contract', () => {
  it('preserves the shared current-edge guards verbatim', () => {
    // Not merely "contains the clauses" — the default must embed the exact
    // fragment every other current-graph reader uses, so a future edit to the
    // temporal/claim rule cannot silently diverge here.
    expect(DEFAULT_GRAPH_QUERY).toContain(currentEdgePredicate('r'));
  });

  it('constrains BOTH endpoints to the same label set the Domain view partitions on', () => {
    expect(DOMAIN_LABEL_LIST_LITERAL).toBe(`[${[...DOMAIN_NODE_LABELS].map((label) => `'${label}'`).join(', ')}]`);
    expect(DEFAULT_GRAPH_QUERY).toMatch(
      new RegExp(
        `^WITH ${DOMAIN_LABEL_LIST_LITERAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} AS domainLabels\\n` +
          'MATCH \\(n\\)-\\[r\\]->\\(m\\)'
      )
    );
    expect(DEFAULT_GRAPH_QUERY).toContain('any(label IN labels(n) WHERE label IN domainLabels)');
    expect(DEFAULT_GRAPH_QUERY).toContain('any(label IN labels(m) WHERE label IN domainLabels)');
  });

  it('excludes the ingestion-plumbing labels that made Domain render zero relationships', () => {
    for (const auditLabel of ['Chunk', 'Document', 'Assertion', 'Evidence', 'CommunityReport']) {
      expect(DOMAIN_NODE_LABELS.has(auditLabel)).toBe(false);
      expect(DOMAIN_LABEL_LIST_LITERAL).not.toContain(`'${auditLabel}'`);
    }
  });

  it('guarantees every edge the default can return survives the Domain partition', () => {
    // The R2 defect was structural: the shipped default returned edges whose
    // endpoints Domain drops, so Domain could only ever render dust. Because the
    // query now constrains both endpoints to DOMAIN_NODE_LABELS, any response it
    // can produce partitions to a NON-EMPTY edge set — this is the invariant, not
    // a property of one fixture.
    const nodes = [...DOMAIN_NODE_LABELS].map((label, index) => ({
      id: `n-${index}`,
      labels: [label],
    }));
    const edges = nodes.slice(1).map((node, index) => ({
      id: `r-${index}`,
      from: nodes[index].id,
      to: node.id,
    }));

    const partition = partitionGraphView(nodes, edges, 'domain');

    expect(partition.visibleNodeIds.size).toBe(nodes.length);
    expect(partition.visibleEdgeIds.size).toBe(edges.length);
    expect(edges.length).toBeGreaterThan(0);
  });

  it('is accepted by the server-side raw-Cypher read policy', () => {
    // The default now opens on `WITH`, not `MATCH`. Prove the policy that gates
    // every caller-supplied query still admits it — a default the workbench
    // auto-runs but the server refuses would be a first-paint error, not a graph.
    const decision = inspectCypherReadQuery(DEFAULT_GRAPH_QUERY);
    expect(decision).toMatchObject({ allowed: true });
    expect(decision.code).toBeUndefined();
    expect(decision.queryBytes).toBeLessThanOrEqual(RAW_CYPHER_LIMITS.queryBytes);
  });

  it('leaves the shared display caps untouched', () => {
    expect(GRAPH_QUERY_LIMITS.nodes).toBe(300);
    expect(GRAPH_QUERY_LIMITS.relationships).toBe(600);
    expect(DEFAULT_GRAPH_QUERY).toContain('LIMIT 100');
  });
});

describe('Graph Explorer progressive expansion contract', () => {
  it('turns a large hub response into one complete bounded page plus lookahead', () => {
    const nodes = [{ id: 'document' }, ...Array.from({ length: 49 }, (_, index) => ({ id: `chunk-${index}` }))];
    const relationships = Array.from({ length: 49 }, (_, index) => ({
      id: `contains-${index}`,
      from: 'document',
      to: `chunk-${index}`,
    }));

    const page = selectGraphExpansionPage(nodes, relationships);

    expect(page.relationships).toHaveLength(GRAPH_EXPANSION_PAGE_SIZE);
    expect(page.nodes).toHaveLength(GRAPH_EXPANSION_PAGE_SIZE + 1);
    expect(page.hasMore).toBe(true);
    const pageNodeIds = new Set(page.nodes.map((node) => node.id));
    for (const relationship of page.relationships) {
      expect(pageNodeIds.has(relationship.from)).toBe(true);
      expect(pageNodeIds.has(relationship.to)).toBe(true);
    }
    expect(pageNodeIds.has(`chunk-${GRAPH_EXPANSION_PAGE_SIZE}`)).toBe(false);
  });

  it('excludes only visible relationship element IDs incident to the selected node', () => {
    expect(
      getVisibleNeighborRelationshipIds(
        [
          { id: 'r-1', from: 'document', to: 'chunk-1' },
          { id: 'r-2', from: 'other-a', to: 'other-b' },
          { id: 'r-3', from: 'chunk-2', to: 'document' },
        ],
        'document'
      )
    ).toEqual(['r-1', 'r-3']);
  });

  it('marks a short final page complete and drops unrelated response nodes', () => {
    const page = selectGraphExpansionPage(
      [{ id: 'hub' }, { id: 'visible' }, { id: 'unrelated' }],
      [{ id: 'r-1', from: 'hub', to: 'visible' }]
    );

    expect(page).toEqual({
      nodes: [{ id: 'hub' }, { id: 'visible' }],
      relationships: [{ id: 'r-1', from: 'hub', to: 'visible' }],
      hasMore: false,
    });
  });

  it('stops at the first complete edge that cannot fit and never adds its orphan endpoint', () => {
    const merged = mergeGraphExpansionPage(
      [{ id: 'hub' }],
      [{ id: 'hub' }, { id: 'neighbor-1' }, { id: 'neighbor-2' }],
      [],
      [
        { id: 'r-1', from: 'hub', to: 'neighbor-1' },
        { id: 'r-2', from: 'hub', to: 'neighbor-2' },
      ],
      { nodes: 2, relationships: 10 }
    );

    expect(merged).toEqual({
      nodes: [{ id: 'hub' }, { id: 'neighbor-1' }],
      relationships: [{ id: 'r-1', from: 'hub', to: 'neighbor-1' }],
      addedNodeCount: 1,
      addedRelationshipCount: 1,
      unacceptedRelationshipCount: 1,
      atGlobalLimit: true,
    });
    expect(merged.nodes).not.toContainEqual({ id: 'neighbor-2' });

    const repeated = mergeGraphExpansionPage(
      merged.nodes,
      [{ id: 'hub' }, { id: 'neighbor-2' }],
      merged.relationships,
      [{ id: 'r-2', from: 'hub', to: 'neighbor-2' }],
      { nodes: 2, relationships: 10 }
    );
    expect(repeated.addedNodeCount).toBe(0);
    expect(repeated.addedRelationshipCount).toBe(0);
    expect(repeated.unacceptedRelationshipCount).toBe(1);
    expect(repeated.atGlobalLimit).toBe(true);
  });

  it('deduplicates relationships and refuses rows with missing endpoints', () => {
    const merged = mergeGraphExpansionPage(
      [{ id: 'hub' }, { id: 'visible' }],
      [{ id: 'hub' }, { id: 'visible' }],
      [{ id: 'r-existing', from: 'hub', to: 'visible' }],
      [
        { id: 'r-existing', from: 'hub', to: 'visible' },
        { id: 'r-malformed', from: 'hub', to: 'missing' },
      ],
      { nodes: 10, relationships: 10 }
    );

    expect(merged.nodes).toHaveLength(2);
    expect(merged.relationships).toHaveLength(1);
    expect(merged.addedRelationshipCount).toBe(0);
    expect(merged.unacceptedRelationshipCount).toBe(1);
    expect(merged.atGlobalLimit).toBe(false);
  });

  it('reports the shared node or relationship display cap', () => {
    expect(isGraphAtExpansionLimit([{ id: 'n-1' }], [], { nodes: 1, relationships: 2 })).toBe(true);
    expect(
      isGraphAtExpansionLimit([{ id: 'n-1' }], [{ id: 'r-1', from: 'n-1', to: 'n-1' }], { nodes: 2, relationships: 1 })
    ).toBe(true);
    expect(isGraphAtExpansionLimit([{ id: 'n-1' }], [], { nodes: 2, relationships: 1 })).toBe(false);
  });
});
