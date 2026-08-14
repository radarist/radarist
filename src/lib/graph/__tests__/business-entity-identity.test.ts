/**
 * @file business-entity-identity.test.ts
 * @description AI-026 — the masquerade contract.
 *
 * The live defect: `recommendTechInvestments` recommended an `:AgentObservation`
 * as a Technology because the observation carries `entityType: 'technology'`,
 * copied from the entity it is ABOUT. This suite pins the rule that closes it —
 * identity comes from the node's LABEL SET, never from the property alone — and,
 * crucially, pins it against EVERY internal-memory label the codebase actually
 * writes rather than a single example, plus a drift test that fails when a new
 * label appears in source without being classified.
 *
 * @jest-environment node
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  businessEntityGraphType,
  businessEntityIdentityCypher,
  businessEntityIdentityParams,
  businessEntityLabelProjection,
  businessEntityLabelScopeCypher,
  businessEntityTypeScopeCypher,
  filterBusinessEntityNodes,
  graphLabelForEntityType,
  graphLabelsForEntityTypes,
  isBusinessEntityNode,
  ENTITY_PROJECTION_GRAPH_LABELS,
  GENERIC_ENTITY_GRAPH_LABEL,
  INTERNAL_MEMORY_ENTITY_TYPES,
  INTERNAL_MEMORY_GRAPH_LABELS,
} from '../business-entity-identity';
import { BUSINESS_ENTITY_GRAPH_LABELS, ENTITY_TYPE_GRAPH_LABEL } from '../entity-type-vocab';

/**
 * Every node label written by a literal Cypher pattern anywhere under `src/`,
 * classified. This is the contract's own vocabulary: the four pre-existing label
 * lists in the codebase (`CONTEXT_NODE_LABELS`, `CONTEXT_SCHEMA`, the canonical
 * schema-manifest constraints, `GRAPH_RETRIEVAL_EXCLUDED_LABELS`) each both
 * over- and under-covered what is actually written, which is how 15 bookkeeping
 * labels came to be missing from the read filter.
 *
 * `NON_ENTITY` is not a deny-list the predicate consults — the predicate refuses
 * anything outside `ENTITY_PROJECTION_GRAPH_LABELS` by construction. This list
 * exists so the refusal is PROVEN per label, and so `driftTest` below forces a
 * human to classify any label a future change introduces.
 */
const WRITTEN_ENTITY_PROJECTION_LABELS = [
  'Entity',
  'Technology',
  'Company',
  'UseCase',
  'Strategy',
  'Signal',
  'Document',
  'OrgUnit',
  'Initiative',
  'PainPoint',
  'RadarPlacement',
] as const;

const WRITTEN_NON_ENTITY_LABELS = [
  // agent / user memory
  'AgentObservation',
  'AgentReflection',
  'AgentRun',
  'Episode',
  'Observation',
  'Session',
  'User',
  'UserPreference',
  'PreferenceEngagementReceipt',
  'InterestProfile',
  'AsserterReliability',
  'ProactiveInsight',
  'CuriosityGap',
  // reification / derived / operational
  'Assertion',
  'Claim',
  'Evidence',
  'Chunk',
  'Concept',
  'CommunityReport',
  'RelationType',
  'VerificationResult',
  'EdgeVerificationResult',
  'SchemaMigration',
  'MigrationCensus',
  // a container, not an entity projection
  'Radar',
] as const;

/**
 * Labels `ENTITY_TYPE_GRAPH_LABEL` declares but no LITERAL Cypher pattern writes,
 * because their writer interpolates the label (`MERGE (e:Entity:${label} …)` in
 * `sync-entity-to-neo4j.ts`). Listed so the drift test can require the two sets
 * to account for the whole declared vocabulary.
 */
const INTERPOLATED_ONLY_ENTITY_LABELS = ['Prototype'] as const;

/** A node shaped like the real projection a writer produces. */
function projection(label: string, entityType: string, extra: Record<string, unknown> = {}) {
  return {
    labels: [GENERIC_ENTITY_GRAPH_LABEL, label],
    properties: { name: `${label} fixture`, entityType, ...extra },
  };
}

/**
 * A decoy: a bookkeeping node carrying the `entityType` of the business entity it
 * is about, and `entityName`/`title` instead of `name` — the exact shape
 * `recordAgentObservation` (`proactive-insights.ts`) and `recordSweepObservation`
 * (`sweep-observations.ts`) write.
 */
function decoy(label: string, entityType = 'technology') {
  return {
    labels: [label],
    properties: { entityId: 'tech-1', entityName: 'Kubernetes', title: 'Watched', entityType },
  };
}

describe('AI-026 — internal-memory nodes can never resolve as a business entity', () => {
  it.each(WRITTEN_NON_ENTITY_LABELS)('refuses :%s carrying entityType:"technology" as a Technology', (label) => {
    const node = decoy(label);
    expect(isBusinessEntityNode(node, 'technology')).toBe(false);
    // Also refused as "a business entity" with no type requested, so an
    // unscoped read cannot admit it either.
    expect(isBusinessEntityNode(node)).toBe(false);
    // And the render boundary must not name it.
    expect(businessEntityGraphType(node)).toBeUndefined();
    expect(filterBusinessEntityNodes([node], 'technology')).toEqual([]);
  });

  it.each(WRITTEN_NON_ENTITY_LABELS)('refuses :%s whichever business entityType it copies', (label) => {
    for (const entityType of Object.keys(ENTITY_TYPE_GRAPH_LABEL)) {
      const node = decoy(label, entityType);
      expect(isBusinessEntityNode(node, entityType)).toBe(false);
      expect(businessEntityGraphType(node)).toBeUndefined();
    }
  });

  it('refuses a bookkeeping node that also acquired :Entity and a canonical label', () => {
    // `createNode(labels, …)` / `bulkCreateNodes` accept arbitrary caller labels,
    // so the "bookkeeping never carries :Entity" invariant is not enforced at the
    // write boundary. The internal-memory list is what covers this case: the
    // foreign-label rule alone would admit it.
    const node = {
      labels: ['Entity', 'Technology', 'AgentObservation'],
      properties: { name: 'Looks real', entityType: 'technology' },
    };
    expect(isBusinessEntityNode(node, 'technology')).toBe(false);
    expect(isBusinessEntityNode(node)).toBe(false);
    expect(businessEntityGraphType(node)).toBeUndefined();
  });

  it('refuses a node whose entityType is itself internal-memory vocabulary', () => {
    for (const entityType of INTERNAL_MEMORY_ENTITY_TYPES) {
      expect(isBusinessEntityNode({ labels: ['Entity'], properties: { entityType } })).toBe(false);
    }
  });
});

describe('AI-026 — canonical business entities still resolve', () => {
  it.each(Object.entries(ENTITY_TYPE_GRAPH_LABEL))(
    'admits a %s projection and reports its type from the label',
    (entityType, label) => {
      const node = projection(label, entityType);
      expect(isBusinessEntityNode(node, entityType)).toBe(true);
      expect(isBusinessEntityNode(node)).toBe(true);
      expect(businessEntityGraphType(node)).toBe(entityType);
    }
  );

  it('reports the type from the label when the mirrored entityType property is absent', () => {
    // `sync-document-to-neo4j.ts` never sets `d.entityType`, so a Document has
    // only its label to go on.
    const node = { labels: ['Entity', 'Document'], properties: { title: 'Spec' } };
    expect(isBusinessEntityNode(node, 'document')).toBe(true);
    expect(businessEntityGraphType(node)).toBe('document');
  });

  it('refuses a canonical projection when a DIFFERENT type was requested', () => {
    const node = projection('Technology', 'technology');
    expect(isBusinessEntityNode(node, 'company')).toBe(false);
  });

  it('trusts the label over a contradicting entityType property', () => {
    const node = { labels: ['Entity', 'Technology'], properties: { name: 'X', entityType: 'company' } };
    expect(isBusinessEntityNode(node, 'company')).toBe(false);
    expect(isBusinessEntityNode(node, 'technology')).toBe(true);
    expect(businessEntityGraphType(node)).toBe('technology');
  });
});

describe('AI-026 — the endpoint placeholder stays reachable', () => {
  /**
   * `assertions.ts` and `relation-assertion-sync.ts` MERGE a relation endpoint as
   * a bare `(:Entity)` with only `entityType` set, when a relation reaches the
   * graph before its endpoint's own projection. A plain
   * `BUSINESS_ENTITY_GRAPH_LABELS` allow-list would silently drop these real
   * entities — the mirror-image failure of the property-only filter.
   */
  const placeholder = { labels: ['Entity'], properties: { name: 'Pending Tech', entityType: 'technology' } };

  it('admits a label-less endpoint placeholder for its own entityType', () => {
    expect(isBusinessEntityNode(placeholder, 'technology')).toBe(true);
    expect(isBusinessEntityNode(placeholder)).toBe(true);
    expect(businessEntityGraphType(placeholder)).toBe('technology');
  });

  it('does not let a placeholder answer for a different type', () => {
    expect(isBusinessEntityNode(placeholder, 'company')).toBe(false);
  });

  it('accepts the legacy snake_case placeholder vocabulary', () => {
    const legacy = { labels: ['Entity'], properties: { entityType: 'org_unit' } };
    expect(isBusinessEntityNode(legacy, 'orgUnit')).toBe(true);
    expect(businessEntityGraphType(legacy)).toBe('orgUnit');
  });

  it('refuses a placeholder with no entityType when a type was requested', () => {
    expect(isBusinessEntityNode({ labels: ['Entity'], properties: {} }, 'technology')).toBe(false);
  });

  it('refuses an unmappable requested type rather than falling through', () => {
    expect(isBusinessEntityNode(placeholder, 'not-a-type')).toBe(false);
  });
});

describe('AI-026 — canonical label vocabulary', () => {
  it('resolves every declared entityType, in every accepted spelling', () => {
    for (const [entityType, label] of Object.entries(ENTITY_TYPE_GRAPH_LABEL)) {
      expect(graphLabelForEntityType(entityType)).toBe(label);
      expect(graphLabelForEntityType(entityType.toUpperCase())).toBe(label);
      expect(graphLabelForEntityType(entityType.replace(/([A-Z])/g, '_$1').toLowerCase())).toBe(label);
    }
  });

  it('covers document and radarPlacement — the two the forked copy omitted', () => {
    // `subgraph-rag.ts` kept its own hand-maintained map without these, so a
    // `document`-scoped resolution had no label to require and fell back to the
    // property alone.
    expect(graphLabelForEntityType('document')).toBe('Document');
    expect(graphLabelForEntityType('radarPlacement')).toBe('RadarPlacement');
  });

  it('returns a deterministic, deduped, sorted label set', () => {
    expect(graphLabelsForEntityTypes(['pain_point', 'painPoint', 'technology'])).toEqual(['PainPoint', 'Technology']);
  });

  it('drops unmappable types so a scope with no resolvable label fails closed', () => {
    expect(graphLabelsForEntityTypes(['nonsense'])).toEqual([]);
  });

  it('never classifies an internal-memory label as an entity projection', () => {
    for (const label of INTERNAL_MEMORY_GRAPH_LABELS) {
      expect(ENTITY_PROJECTION_GRAPH_LABELS).not.toContain(label);
    }
  });

  it('exposes Entity plus exactly the canonical labels as the projection set', () => {
    expect([...ENTITY_PROJECTION_GRAPH_LABELS].sort()).toEqual(
      [GENERIC_ENTITY_GRAPH_LABEL, ...BUSINESS_ENTITY_GRAPH_LABELS].sort()
    );
  });
});

describe('AI-026 — Cypher predicates are fully parameterized', () => {
  const identity = businessEntityIdentityCypher('n');
  const scope = businessEntityTypeScopeCypher('n');

  it('binds every label as a parameter, never interpolated into the query', () => {
    for (const fragment of [identity, scope, businessEntityLabelScopeCypher('n'), businessEntityLabelProjection('n')]) {
      for (const label of [...ENTITY_PROJECTION_GRAPH_LABELS, ...INTERNAL_MEMORY_GRAPH_LABELS]) {
        expect(fragment).not.toContain(`'${label}'`);
      }
    }
  });

  it('requires the absence of internal-memory and foreign labels', () => {
    expect(identity).toContain('$internalMemoryLabels');
    expect(identity).toContain('$entityProjectionLabels');
    expect(identity).toContain('$internalMemoryEntityTypes');
  });

  it('gates the entityType property branch on there being no canonical label', () => {
    expect(scope.replace(/\s+/g, ' ')).toContain(
      'NONE(identityLabel IN labels(n) WHERE identityLabel IN $businessEntityLabels) ' +
        'AND ($targetTypes IS NULL OR n.entityType IN $targetTypes)'
    );
  });

  it('offers a strict label-only scope with no property branch', () => {
    expect(businessEntityLabelScopeCypher('n')).not.toContain('entityType');
  });

  it('binds the exact runtime vocabulary', () => {
    expect(businessEntityIdentityParams()).toEqual({
      businessEntityLabels: BUSINESS_ENTITY_GRAPH_LABELS,
      entityProjectionLabels: ENTITY_PROJECTION_GRAPH_LABELS,
      internalMemoryLabels: INTERNAL_MEMORY_GRAPH_LABELS,
      internalMemoryEntityTypes: INTERNAL_MEMORY_ENTITY_TYPES,
    });
  });
});

describe('AI-026 — label vocabulary drift', () => {
  /**
   * Scan every literal Cypher node pattern under `src/` for the labels it writes
   * or matches. A label that is neither a classified entity projection nor a
   * classified non-entity label fails this test, which forces whoever adds one to
   * decide whether reads must admit it. Without this, a new bookkeeping label
   * ships silently — the way 15 of them already had.
   */
  function scanGraphNodeLabels(): Map<string, string[]> {
    const nodePattern = /(?:MERGE|CREATE|MATCH)\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*([A-Z][A-Za-z0-9_]*)/g;
    const labelPromotionPattern = /\bSET\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*([A-Z][A-Za-z0-9_]*)/g;
    const found = new Map<string, string[]>();

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const source = readFileSync(full, 'utf8');
        for (const pattern of [nodePattern, labelPromotionPattern]) {
          pattern.lastIndex = 0;
          for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
            const sites = found.get(match[1]) ?? [];
            if (!sites.includes(full)) sites.push(full);
            found.set(match[1], sites);
          }
        }
      }
    };

    walk(join(process.cwd(), 'src'));
    return found;
  }

  const scanned = scanGraphNodeLabels();

  it('finds the labels it is supposed to scan (the scan itself is not vacuous)', () => {
    expect(scanned.size).toBeGreaterThan(30);
    for (const label of ['Technology', 'Entity', 'AgentObservation', 'Assertion']) {
      expect(scanned.has(label)).toBe(true);
    }
  });

  it('classifies every label written in source', () => {
    const classified = new Set<string>([...WRITTEN_ENTITY_PROJECTION_LABELS, ...WRITTEN_NON_ENTITY_LABELS]);
    const unclassified = [...scanned.keys()].filter((label) => !classified.has(label)).sort();
    expect(unclassified).toEqual([]);
  });

  it('accounts for the whole declared entity vocabulary', () => {
    expect([...WRITTEN_ENTITY_PROJECTION_LABELS, ...INTERPOLATED_ONLY_ENTITY_LABELS].sort()).toEqual(
      [...ENTITY_PROJECTION_GRAPH_LABELS].sort()
    );
  });

  it('admits every classified entity-projection label and refuses every other one', () => {
    for (const label of WRITTEN_ENTITY_PROJECTION_LABELS) {
      expect(ENTITY_PROJECTION_GRAPH_LABELS).toContain(label);
      expect(isBusinessEntityNode({ labels: [label], properties: { name: 'x' } })).toBe(true);
    }
    for (const label of WRITTEN_NON_ENTITY_LABELS) {
      expect(ENTITY_PROJECTION_GRAPH_LABELS).not.toContain(label);
      expect(isBusinessEntityNode(decoy(label))).toBe(false);
    }
  });
});
