/**
 * @file relation-link-audit.test.ts
 * @description TEST-012 — the failure-first control for the acceptance harness.
 *
 * An acceptance harness that cannot fail is worse than no harness: vacuous graph
 * assertions and tab checks coupled to unrelated data can both appear green.
 * Before the browser lane is allowed to claim anything, every assertion it uses
 * is required HERE to report a problem when the product is broken — a decoy internal-memory endpoint,
 * a missing graph write, a wrong predicate, a reversed direction, a duplicated
 * edge, residue left behind, and a defect that a later passing step tries to
 * mask.
 *
 * @jest-environment node
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AuditDefectLedger,
  AuditLedgerError,
  diffTabRows,
  linkConvergenceProblems,
  ownedMutationProblems,
  relationConvergenceProblems,
  residueProblems,
  unrelatedChangeProblems,
  type CapturedLinkIdentity,
  type CapturedRelationIdentity,
  type ObservedGraphEdge,
  type ObservedLinkEdge,
} from '../relation-link-audit';

const CAPTURED: CapturedRelationIdentity = {
  relationId: 'rel-owned',
  sourceId: 'usecase-1',
  sourceEntityType: 'useCase',
  targetId: 'tech-1',
  targetEntityType: 'technology',
  predicate: 'SOLVES',
};

const CONVERGED: ObservedGraphEdge = {
  relationId: 'rel-owned',
  type: 'SOLVES',
  startId: 'usecase-1',
  endId: 'tech-1',
  startLabels: ['Entity', 'UseCase'],
  endLabels: ['Entity', 'Technology'],
};

const CAPTURED_LINK: CapturedLinkIdentity = {
  linkId: 'link-owned',
  entityId: 'tech-1',
  entityEntityType: 'technology',
  documentId: 'doc-1',
  predicate: 'DOCUMENTED_BY',
};

const CONVERGED_LINK: ObservedLinkEdge = {
  linkId: 'link-owned',
  type: 'DOCUMENTED_BY',
  startId: 'tech-1',
  endId: 'doc-1',
  startLabels: ['Entity', 'Technology'],
  endLabels: ['Entity', 'Document'],
};

describe('relation convergence — the assertion must be capable of failing', () => {
  it('passes only on an exactly-converged edge (the positive control)', () => {
    expect(relationConvergenceProblems(CAPTURED, [CONVERGED])).toEqual([]);
  });

  it('fails on a MISSING graph write', () => {
    // The core vacuity the row names: Firestore said yes, Neo4j never converged.
    expect(relationConvergenceProblems(CAPTURED, [])).toEqual(['no Neo4j edge carries relationId rel-owned']);
  });

  it('fails when only an UNRELATED edge exists between the same endpoints', () => {
    // `relationsBefore.length >= 1` is satisfied by any pre-existing relation.
    // Identity is what distinguishes the journey's own write from ambient state.
    const foreign: ObservedGraphEdge = { ...CONVERGED, relationId: 'rel-someone-else' };
    expect(relationConvergenceProblems(CAPTURED, [foreign])).toEqual(['no Neo4j edge carries relationId rel-owned']);
  });

  it('fails on a DECOY internal-memory endpoint carrying the business entityType', () => {
    // AI-026's masquerade, seen from the acceptance side: the edge has the right
    // identity, predicate and direction, and the endpoint claims to be a
    // technology — only its LABEL gives it away.
    const decoy: ObservedGraphEdge = { ...CONVERGED, endLabels: ['AgentObservation'] };
    expect(relationConvergenceProblems(CAPTURED, [decoy])).toEqual([
      'target endpoint carries labels ["AgentObservation"], which do not prove a technology',
    ]);
  });

  it('fails on an endpoint that is a business entity of the WRONG type', () => {
    const wrongType: ObservedGraphEdge = { ...CONVERGED, endLabels: ['Entity', 'Company'] };
    expect(relationConvergenceProblems(CAPTURED, [wrongType])).toEqual([
      'target endpoint carries labels ["Entity","Company"], which do not prove a technology',
    ]);
  });

  it('fails on a label-less endpoint that never got its projection', () => {
    const unlabelled: ObservedGraphEdge = { ...CONVERGED, startLabels: ['Entity'] };
    expect(relationConvergenceProblems(CAPTURED, [unlabelled])).toEqual([
      'source endpoint carries labels ["Entity"], which do not prove a useCase',
    ]);
  });

  it('fails on the WRONG predicate', () => {
    expect(relationConvergenceProblems(CAPTURED, [{ ...CONVERGED, type: 'USES' }])).toEqual([
      'predicate is USES, expected SOLVES',
    ]);
  });

  it('fails on a REVERSED direction', () => {
    const reversed: ObservedGraphEdge = {
      ...CONVERGED,
      startId: 'tech-1',
      endId: 'usecase-1',
      startLabels: ['Entity', 'Technology'],
      endLabels: ['Entity', 'UseCase'],
    };
    expect(relationConvergenceProblems(CAPTURED, reversed ? [reversed] : [])).toEqual([
      'direction is tech-1 -> usecase-1, expected usecase-1 -> tech-1',
      'source endpoint carries labels ["Entity","Technology"], which do not prove a useCase',
      'target endpoint carries labels ["Entity","UseCase"], which do not prove a technology',
    ]);
  });

  it('fails on a DUPLICATED edge for one relation identity', () => {
    const problems = relationConvergenceProblems(CAPTURED, [CONVERGED, CONVERGED]);
    expect(problems).toContain('2 Neo4j edges carry relationId rel-owned; exactly one is required');
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const broken: ObservedGraphEdge = { ...CONVERGED, type: 'USES', endLabels: ['AgentObservation'] };
    expect(relationConvergenceProblems(CAPTURED, [broken])).toHaveLength(2);
  });
});

describe('link convergence — the assertion must be capable of failing', () => {
  it('passes only on an exactly-converged link (the positive control)', () => {
    expect(linkConvergenceProblems(CAPTURED_LINK, [CONVERGED_LINK])).toEqual([]);
  });

  it('fails on a missing link edge', () => {
    expect(linkConvergenceProblems(CAPTURED_LINK, [])).toEqual(['no Neo4j edge carries linkId link-owned']);
  });

  it('fails when the document endpoint is not a Document', () => {
    const decoy: ObservedLinkEdge = { ...CONVERGED_LINK, endLabels: ['Chunk'] };
    expect(linkConvergenceProblems(CAPTURED_LINK, [decoy])).toEqual([
      'document endpoint carries labels ["Chunk"], which do not prove a document',
    ]);
  });

  it('fails on a reversed link direction', () => {
    const reversed: ObservedLinkEdge = {
      ...CONVERGED_LINK,
      startId: 'doc-1',
      endId: 'tech-1',
      startLabels: ['Entity', 'Document'],
      endLabels: ['Entity', 'Technology'],
    };
    expect(linkConvergenceProblems(CAPTURED_LINK, [reversed])).toContain(
      'direction is doc-1 -> tech-1, expected tech-1 -> doc-1'
    );
  });
});

describe('relation-tab assertions tolerate unrelated change but prove their own', () => {
  const OWNED = 'Kubernetes';

  it('proves the owned row appeared while three unrelated rows also moved', () => {
    const before = ['Airflow', 'Kafka', 'Spark'];
    const after = ['Airflow', 'Kubernetes', 'Postgres', 'Redis'];

    expect(ownedMutationProblems(before, after, { added: [OWNED] })).toEqual([]);
    expect(diffTabRows(before, after)).toEqual({
      added: ['Kubernetes', 'Postgres', 'Redis'],
      removed: ['Kafka', 'Spark'],
    });
    // The count went 3 -> 4 while the owned mutation was +1: a count assertion
    // would have been wrong in both directions.
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(4);
  });

  it('still fails when the owned row never appears, however much else changed', () => {
    expect(ownedMutationProblems(['Kafka'], ['Postgres', 'Redis'], { added: [OWNED] })).toEqual([
      '"Kubernetes" never appeared in the tab after the mutation',
    ]);
  });

  it('refuses a row that was ALREADY present before the mutation', () => {
    // The precondition failure `cascade-delete-relations.spec.ts` cannot detect:
    // ambient state satisfying the proof.
    expect(ownedMutationProblems([OWNED], [OWNED], { added: [OWNED] })).toEqual([
      '"Kubernetes" was already present before the mutation, so its appearance proves nothing',
    ]);
  });

  it('proves a removal, and fails when the row is still there', () => {
    expect(ownedMutationProblems([OWNED, 'Kafka'], ['Kafka'], { removed: [OWNED] })).toEqual([]);
    expect(ownedMutationProblems([OWNED, 'Kafka'], [OWNED, 'Kafka', 'Redis'], { removed: [OWNED] })).toEqual([
      '"Kubernetes" is still in the tab after removal',
    ]);
  });

  it('requires the tolerance to have been exercised, not merely claimed', () => {
    // Nothing unrelated moved: the run proves the mutation but proves nothing
    // about tolerance, and must say so instead of implying coverage.
    expect(unrelatedChangeProblems(['Kafka'], ['Kafka', OWNED], [OWNED])).toEqual([
      'the tab saw no unrelated change during the journey, so count-tolerance was never exercised ' +
        '(added: ["Kubernetes"], removed: [])',
    ]);
    expect(unrelatedChangeProblems(['Kafka'], ['Kafka', OWNED, 'Redis'], [OWNED])).toEqual([]);
  });
});

describe('defect aggregation cannot turn a product failure green', () => {
  const CHECKPOINTS = ['relation-write', 'graph-convergence', 'cleanup'] as const;

  it('passes only when every checkpoint completed and nothing was recorded', () => {
    const ledger = new AuditDefectLedger();
    for (const checkpoint of CHECKPOINTS) ledger.complete(checkpoint);
    expect(() => ledger.assertClean(CHECKPOINTS)).not.toThrow();
    expect(ledger.defects).toEqual([]);
  });

  it('reports every defect in one failure instead of stopping at the first', () => {
    const ledger = new AuditDefectLedger();
    ledger.record('relation-write', new Error('POST /api/relations returned 500'));
    ledger.record('graph-convergence', new Error('no Neo4j edge carries relationId rel-owned'));
    ledger.complete('cleanup');

    let thrown: AuditLedgerError | undefined;
    try {
      ledger.assertClean(CHECKPOINTS);
    } catch (error) {
      thrown = error as AuditLedgerError;
    }

    expect(thrown).toBeInstanceOf(AuditLedgerError);
    expect(thrown?.defects.map((defect) => defect.checkpoint)).toEqual(['relation-write', 'graph-convergence']);
    expect(thrown?.message).toContain('POST /api/relations returned 500');
    expect(thrown?.message).toContain('no Neo4j edge carries relationId rel-owned');
  });

  it('a later passing step cannot mask an earlier defect', () => {
    const ledger = new AuditDefectLedger();
    ledger.record('graph-convergence', new Error('missing edge'));
    // Everything afterwards succeeds, including a retry of the same checkpoint.
    for (const checkpoint of CHECKPOINTS) ledger.complete(checkpoint);

    expect(ledger.defects).toHaveLength(1);
    expect(ledger.completedCheckpoints).not.toContain('graph-convergence');
    expect(() => ledger.assertClean(CHECKPOINTS)).toThrow(AuditLedgerError);
  });

  it('a run that never reached a checkpoint cannot look clean', () => {
    // A crash, a timeout, or a helper that silently returned instead of acting.
    const ledger = new AuditDefectLedger();
    ledger.complete('relation-write');

    expect(() => ledger.assertClean(CHECKPOINTS)).toThrow(/never completed: graph-convergence, cleanup/);
  });

  it('records a non-Error throw without losing it', () => {
    const ledger = new AuditDefectLedger();
    ledger.record('relation-write', 'timed out waiting for the toast');
    expect(ledger.defects[0]).toMatchObject({
      checkpoint: 'relation-write',
      summary: 'timed out waiting for the toast',
    });
    expect(() => ledger.assertClean(['relation-write'])).toThrow(AuditLedgerError);
  });
});

describe('the ledger survives the process restart that would erase it', () => {
  /**
   * Playwright starts a NEW worker process after a test failure and re-imports
   * the spec. An in-memory ledger is silently reset by that, so the gate reports
   * "no checkpoint ever ran" and every defect recorded before the first failure
   * is lost. This lane hit exactly that on its first run — hence the durable log,
   * which doubles as the run's receipt.
   */
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relation-link-audit-ledger-'));
    file = join(dir, 'nested', 'ledger.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replays completions and defects into a fresh instance', () => {
    const first = new AuditDefectLedger({ file });
    first.complete('relation-write');
    first.record('graph-convergence', new Error('no Neo4j edge carries relationId rel-owned'));

    // The restart.
    const second = new AuditDefectLedger({ file });
    expect(second.completedCheckpoints).toEqual(['relation-write']);
    expect(second.defects).toHaveLength(1);
    expect(second.defects[0].summary).toContain('no Neo4j edge');
    expect(() => second.assertClean(['relation-write', 'graph-convergence'])).toThrow(AuditLedgerError);
  });

  it('keeps a defect authoritative over a completion replayed after it', () => {
    const first = new AuditDefectLedger({ file });
    first.record('graph-convergence', new Error('missing edge'));
    first.complete('graph-convergence');

    const second = new AuditDefectLedger({ file });
    expect(second.completedCheckpoints).not.toContain('graph-convergence');
    expect(second.defects).toHaveLength(1);
  });

  it('creates the ledger directory rather than failing on a fresh run', () => {
    expect(() => new AuditDefectLedger({ file })).not.toThrow();
    expect(existsSync(dirname(file))).toBe(true);
  });

  it('is still a pure in-memory ledger when no file is configured', () => {
    const ledger = new AuditDefectLedger();
    ledger.complete('relation-write');
    expect(ledger.completedCheckpoints).toEqual(['relation-write']);
    expect(existsSync(file)).toBe(false);
  });
});

describe('cleanup is asserted, not best-effort', () => {
  it('passes on zero residue', () => {
    expect(residueProblems({ firestoreRelations: 0, firestoreLinks: 0, graphNodes: 0, graphEdges: 0 })).toEqual([]);
  });

  it('names every kind of residue left behind', () => {
    expect(residueProblems({ firestoreRelations: 2, firestoreLinks: 0, graphNodes: 1, graphEdges: 3 })).toEqual([
      'firestoreRelations left 2 record(s) behind',
      'graphNodes left 1 record(s) behind',
      'graphEdges left 3 record(s) behind',
    ]);
  });
});
