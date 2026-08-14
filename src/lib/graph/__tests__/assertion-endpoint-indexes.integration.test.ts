/**
 * PERF-012: real-planner proof for assertion endpoint indexes.
 *
 * The production explainConnection reader intentionally supports both the
 * current :Assertion label and legacy :Claim rows until an operator runs the
 * manual schema-simplification migration. This suite proves that exact dual-
 * label query shape remains bounded on Neo4j Community, and that its results
 * equal explicit label-scan references.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Session } from 'neo4j-driver';
import {
  assertDisposableNeo4jIntegrationSuiteTarget,
  isDisposableNeo4jIntegrationSuiteEnabled,
} from '../../../../scripts/testing/run-neo4j-integration';
import { INDEXES, parseSchemaObjectName } from '../schema-manifest';
import {
  checkHealth,
  closeDriver,
  getSession,
  runReadTransaction,
  runWriteTransaction,
} from '../neo4j-client';

const TEST_MARKER = 'perf012-assertion-endpoint-index-proof';
const TEST_PREFIX = `${TEST_MARKER}-`;
const FIXTURE_ROWS_PER_LABEL = 10_000;
const SOURCE_ID = `${TEST_PREFIX}subject-7`;
const TARGET_ID = `${TEST_PREFIX}object-7`;
const SUPPORTED_LABELS = ['Assertion', 'Claim'] as const;
const INDEX_NAMES = [
  'assertion_subject',
  'assertion_object',
  'legacy_claim_subject',
  'legacy_claim_object',
] as const;
const describeIntegration = isDisposableNeo4jIntegrationSuiteEnabled() ? describe : describe.skip;

type SupportedLabel = (typeof SUPPORTED_LABELS)[number];
type EndpointProperty = 'subjectId' | 'objectId';

interface PlanLike {
  operatorType: string;
  arguments: Record<string, unknown>;
  children: PlanLike[];
}

interface IndexAccess {
  operator: string;
  details: string;
}

interface IndexInventoryRow {
  name: string;
  state: string;
  type: string;
  labelsOrTypes: string[];
  properties: string[];
}

const PAIR_PREDICATE = `
  (claim.subjectId = $sourceId AND claim.objectId = $targetId)
  OR (claim.subjectId = $targetId AND claim.objectId = $sourceId)
`;

// Keep this access shape aligned with explainConnection in assertions.ts.
const PRODUCTION_EXPLAIN_CONNECTION_QUERY = `
  MATCH (claim)
  WHERE (claim:Assertion OR claim:Claim)
    AND coalesce(claim.status, 'proposed') <> 'rejected'
    AND (
      (claim.subjectId = $sourceId AND claim.objectId = $targetId)
      OR (claim.subjectId = $targetId AND claim.objectId = $sourceId)
    )

  OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)
  OPTIONAL MATCH (claim)-[:ASSERTED_BY]->(asserter)
  OPTIONAL MATCH (claim)-[:HAS_PREDICATE]->(relType:RelationType)

  RETURN
    claim,
    collect(DISTINCT evidence) as evidence,
    asserter,
    relType
  ORDER BY coalesce(claim.effectiveConfidence, claim.confidence) DESC
`;

function endpointIndexStatements(): string[] {
  return INDEXES.filter((statement) => {
    const name = parseSchemaObjectName(statement);
    return name !== null && (INDEX_NAMES as readonly string[]).includes(name);
  });
}

function normalizeCypher(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

function flattenPlan(plan: PlanLike): PlanLike[] {
  return [plan, ...plan.children.flatMap(flattenPlan)];
}

function boundedIndexAccesses(plan: PlanLike): IndexAccess[] {
  return flattenPlan(plan)
    .filter((operator) =>
      /^Node(?:Unique)?IndexSeek(?:ByRange)?$/.test(operator.operatorType.split('@', 1)[0] ?? '')
    )
    .map((operator) => ({
      operator: operator.operatorType,
      details: String(operator.arguments.Details ?? ''),
    }));
}

function unboundedSupportedLabelAccesses(plan: PlanLike): IndexAccess[] {
  return flattenPlan(plan)
    .filter((operator) => {
      const name = operator.operatorType.split('@', 1)[0] ?? '';
      const details = String(operator.arguments.Details ?? '').replaceAll('`', '');
      return (
        name === 'AllNodesScan' ||
        (name.includes('Scan') && SUPPORTED_LABELS.some((label) => details.includes(`:${label}`)))
      );
    })
    .map((operator) => ({
      operator: operator.operatorType,
      details: String(operator.arguments.Details ?? ''),
    }));
}

function accessesLabelProperty(
  access: IndexAccess,
  label: SupportedLabel,
  property: EndpointProperty
): boolean {
  return access.details.replaceAll('`', '').includes(`:${label}(${property})`);
}

async function explain(session: Session, query: string): Promise<PlanLike> {
  const result = await session.run(`EXPLAIN ${query}`, {
    sourceId: SOURCE_ID,
    targetId: TARGET_ID,
  });
  if (!result.summary.plan) throw new Error('Neo4j returned no EXPLAIN plan');
  return result.summary.plan as unknown as PlanLike;
}

async function endpointIds(
  label: SupportedLabel,
  property: EndpointProperty,
  forceLabelScan: boolean
): Promise<string[]> {
  const parameter = property === 'subjectId' ? 'sourceId' : 'targetId';
  const result = await runReadTransaction<{ id: string }>(
    `MATCH (claim:${label})
     ${forceLabelScan ? `USING SCAN claim:${label}` : ''}
     WHERE claim.${property} = $${parameter}
     RETURN claim.id AS id
     ORDER BY id`,
    { sourceId: SOURCE_ID, targetId: TARGET_ID }
  );
  return result.records.map((record) => record.id);
}

async function productionConnectionIds(): Promise<string[]> {
  const result = await runReadTransaction<{ claim: { id: string } }>(
    PRODUCTION_EXPLAIN_CONNECTION_QUERY,
    { sourceId: SOURCE_ID, targetId: TARGET_ID }
  );
  return [...new Set(result.records.map((record) => record.claim.id))].sort();
}

async function scanReferenceConnectionIds(): Promise<string[]> {
  const ids = await Promise.all(
    SUPPORTED_LABELS.map(async (label) => {
      const result = await runReadTransaction<{ id: string }>(
        `MATCH (claim:${label})
         USING SCAN claim:${label}
         WHERE coalesce(claim.status, 'proposed') <> 'rejected'
           AND (${PAIR_PREDICATE})
         RETURN claim.id AS id`,
        { sourceId: SOURCE_ID, targetId: TARGET_ID }
      );
      return result.records.map((record) => record.id);
    })
  );
  return [...new Set(ids.flat())].sort();
}

async function cleanupFixtures(): Promise<void> {
  assertDisposableNeo4jIntegrationSuiteTarget();
  await runWriteTransaction(
    `MATCH (node {testMarker: $marker})
     WHERE node:Assertion OR node:Claim
     DETACH DELETE node`,
    { marker: TEST_MARKER }
  );
}

describeIntegration('PERF-012 assertion endpoint indexes (real Neo4j EXPLAIN)', () => {
  beforeAll(async () => {
    assertDisposableNeo4jIntegrationSuiteTarget();

    const health = await checkHealth();
    if (!health.healthy) {
      throw new Error(
        `[Integration Tests] disposable Neo4j is not healthy: ${health.error ?? 'unknown error'}`
      );
    }
    await cleanupFixtures();

    const statements = endpointIndexStatements();
    expect(statements).toHaveLength(INDEX_NAMES.length);
    for (const statement of statements) await runWriteTransaction(statement);

    const schemaSession = getSession('WRITE');
    try {
      await schemaSession.run('CALL db.awaitIndexes(300)');
    } finally {
      await schemaSession.close();
    }

    for (const label of SUPPORTED_LABELS) {
      await runWriteTransaction(
        `UNWIND range(1, $fixtureRows) AS rowNumber
         CREATE (:${label} {
           id: $prefix + $labelKey + '-row-' + toString(rowNumber),
           relationId: $prefix + $labelKey + '-relation-' + toString(rowNumber),
           subjectId: $prefix + 'subject-' + toString(rowNumber % 200),
           objectId: $prefix + 'object-' + toString(rowNumber % 160),
           status: CASE WHEN rowNumber % 19 = 0 THEN 'rejected' ELSE 'proposed' END,
           confidence: rowNumber % 101,
           createdAt: rowNumber,
           testMarker: $marker
         })`,
        {
          fixtureRows: FIXTURE_ROWS_PER_LABEL,
          prefix: TEST_PREFIX,
          labelKey: label.toLowerCase(),
          marker: TEST_MARKER,
        }
      );
      await runWriteTransaction(
        `CREATE (:${label} {
           id: $prefix + $labelKey + '-reverse-pair',
           relationId: $prefix + $labelKey + '-reverse-pair-relation',
           subjectId: $targetId,
           objectId: $sourceId,
           status: 'proposed',
           confidence: 100,
           createdAt: $fixtureRows + 1,
           testMarker: $marker
         })`,
        {
          prefix: TEST_PREFIX,
          labelKey: label.toLowerCase(),
          sourceId: SOURCE_ID,
          targetId: TARGET_ID,
          fixtureRows: FIXTURE_ROWS_PER_LABEL,
          marker: TEST_MARKER,
        }
      );
    }

    await runWriteTransaction(
      `CREATE (:Assertion:Claim {
         id: $prefix + 'dual-label-pair',
         relationId: $prefix + 'dual-label-pair-relation',
         subjectId: $sourceId,
         objectId: $targetId,
         status: 'proposed',
         confidence: 99,
         createdAt: $fixtureRows + 2,
         testMarker: $marker
       })`,
      {
        prefix: TEST_PREFIX,
        sourceId: SOURCE_ID,
        targetId: TARGET_ID,
        fixtureRows: FIXTURE_ROWS_PER_LABEL,
        marker: TEST_MARKER,
      }
    );

    const resampleSession = getSession('WRITE');
    try {
      await resampleSession.run('CALL db.resampleOutdatedIndexes()');
    } finally {
      await resampleSession.close();
    }
  }, 120_000);

  afterAll(async () => {
    await cleanupFixtures();
    await closeDriver();
  }, 60_000);

  it('keeps the planner proof aligned with the production explainConnection query', () => {
    const assertionsSource = readFileSync(resolve(__dirname, '../assertions.ts'), 'utf8');
    expect(normalizeCypher(assertionsSource)).toContain(
      normalizeCypher(PRODUCTION_EXPLAIN_CONNECTION_QUERY)
    );
  });

  it('installs online Community RANGE indexes for both supported labels and endpoints', async () => {
    const inventory = await runReadTransaction<IndexInventoryRow>(
      `SHOW INDEXES YIELD name, state, type, labelsOrTypes, properties
       WHERE name IN $names
       RETURN name, state, type, labelsOrTypes, properties
       ORDER BY name`,
      { names: [...INDEX_NAMES] }
    );

    expect(inventory.records).toEqual([
      {
        name: 'assertion_object',
        state: 'ONLINE',
        type: 'RANGE',
        labelsOrTypes: ['Assertion'],
        properties: ['objectId'],
      },
      {
        name: 'assertion_subject',
        state: 'ONLINE',
        type: 'RANGE',
        labelsOrTypes: ['Assertion'],
        properties: ['subjectId'],
      },
      {
        name: 'legacy_claim_object',
        state: 'ONLINE',
        type: 'RANGE',
        labelsOrTypes: ['Claim'],
        properties: ['objectId'],
      },
      {
        name: 'legacy_claim_subject',
        state: 'ONLINE',
        type: 'RANGE',
        labelsOrTypes: ['Claim'],
        properties: ['subjectId'],
      },
    ]);
  });

  it.each([
    ['Assertion', 'subjectId'],
    ['Assertion', 'objectId'],
    ['Claim', 'subjectId'],
    ['Claim', 'objectId'],
  ] as const)('%s.%s lookup uses a bounded index seek with scan-equivalent results', async (label, property) => {
    const indexed = await endpointIds(label, property, false);
    const scanned = await endpointIds(label, property, true);
    expect(indexed.length).toBeGreaterThan(0);
    expect(indexed).toEqual(scanned);

    const parameter = property === 'subjectId' ? 'sourceId' : 'targetId';
    const session = getSession('READ');
    try {
      const plan = await explain(
        session,
        `MATCH (claim:${label}) WHERE claim.${property} = $${parameter} RETURN claim`
      );
      const accesses = boundedIndexAccesses(plan);
      expect(accesses.some((access) => accessesLabelProperty(access, label, property))).toBe(true);
      expect(unboundedSupportedLabelAccesses(plan)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('bounds the exact production dual-label pair query without changing results', async () => {
    const indexed = await productionConnectionIds();
    const scanned = await scanReferenceConnectionIds();
    expect(indexed).toEqual(scanned);
    expect(indexed).toEqual(
      expect.arrayContaining([
        `${TEST_PREFIX}assertion-reverse-pair`,
        `${TEST_PREFIX}claim-reverse-pair`,
        `${TEST_PREFIX}dual-label-pair`,
      ])
    );

    const session = getSession('READ');
    try {
      const plan = await explain(session, PRODUCTION_EXPLAIN_CONNECTION_QUERY);
      const accesses = boundedIndexAccesses(plan);
      console.info(`[PERF-012] production explainConnection: ${JSON.stringify(accesses)}`);

      for (const label of SUPPORTED_LABELS) {
        expect(
          accesses.some(
            (access) =>
              accessesLabelProperty(access, label, 'subjectId') ||
              accessesLabelProperty(access, label, 'objectId')
          )
        ).toBe(true);
      }
      expect(unboundedSupportedLabelAccesses(plan)).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
