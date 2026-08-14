/**
 * @file relation-link-audit.ts
 * @description TEST-012 — the repository-owned spine of the entity relation /
 * link acceptance harness.
 *
 * A relation acceptance harness can report green without proving a mutation
 * unless it closes these failure modes:
 *
 *  - its graph assertions were **vacuous**. `cascade-delete-relations.spec.ts`
 *    asserts `relationsBefore.length >= 1` without checking the set CONTAINS the
 *    relation it just created, so a silently failed write still satisfies the
 *    precondition; and it reads Firestore only, so the "cascade" claim is made
 *    with no Neo4j read at all.
 *  - its relation-tab assertions were **count-brittle**. `toHaveCount(N)` over a
 *    whole tab couples the proof to unrelated data: one more seeded row turns a
 *    correct product into a failure, and a renamed fixture turns it into a `0`
 *    with no diagnostic.
 *  - and a failing product step could be swallowed, because the helpers it used
 *    (`entity-test-helpers.ts`) return `false` from `.isVisible().catch(…)`, so a
 *    caller that ignores the boolean skips the action and keeps going.
 *
 * Everything here is pure and Playwright-free so it can be unit-tested directly,
 * which is what makes the harness's OWN failure modes provable rather than
 * asserted. `__tests__/relation-link-audit.test.ts` is the failure-first control:
 * it feeds each function a decoy internal-memory endpoint and a missing graph
 * write and requires them to report a problem.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isBusinessEntityNode, graphLabelForEntityType } from '../../src/lib/graph/business-entity-identity';

// ============================================================================
// DEFECT AGGREGATION
// ============================================================================

export interface AuditDefect {
  /** The checkpoint that failed. Stable, so a receipt can be diffed run to run. */
  readonly checkpoint: string;
  /** One-line statement of what the product did wrong. */
  readonly summary: string;
  /** Full failure detail (assertion output, stack, observed values). */
  readonly detail: string;
}

export class AuditLedgerError extends Error {
  constructor(
    message: string,
    readonly defects: readonly AuditDefect[],
    readonly missingCheckpoints: readonly string[]
  ) {
    super(message);
    this.name = 'AuditLedgerError';
  }
}

type LedgerEntry = { readonly kind: 'defect'; readonly defect: AuditDefect } | { readonly kind: 'complete'; readonly checkpoint: string };

/**
 * Collects product defects so ONE run reports ALL of them, without ever letting a
 * recorded defect become a passing step.
 *
 * Four properties make that true, and each is pinned by a unit test:
 *
 *  1. **Append-only.** There is no way to clear or downgrade a recorded defect.
 *     A later successful checkpoint cannot mask an earlier failure.
 *  2. **Completion is asserted, not assumed.** `assertClean` fails when an
 *     expected checkpoint never ran, so a crash or an early return that skips the
 *     rest of the journey can never look like a clean run — which is the failure
 *     mode "aggregate defects" normally introduces.
 *  3. **A checkpoint that recorded a defect is NOT completed.** Recording and
 *     completing are mutually exclusive for the same checkpoint, so the ledger
 *     cannot report "all checkpoints ran, zero defects" for a failed step.
 *  4. **Durable across a process restart.** With `file` set, every entry is
 *     appended to disk immediately and the state is replayed from that file. This
 *     is not optional bookkeeping: Playwright starts a NEW worker process after a
 *     test failure, which re-imports the spec and would silently reset an
 *     in-memory ledger — so the gate would report "no checkpoint ever ran" and
 *     lose every defect recorded before the first failure. Measured, not assumed:
 *     the first run of this lane hit exactly that erasure.
 */
export class AuditDefectLedger {
  private readonly recorded: AuditDefect[] = [];
  private readonly completed = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly file?: string;

  constructor(options: { readonly file?: string } = {}) {
    this.file = options.file;
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      this.replay();
    }
  }

  /** Rebuild state from the durable log, so a fresh process sees the whole run. */
  private replay(): void {
    if (!this.file || !existsSync(this.file)) return;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as LedgerEntry;
      if (entry.kind === 'defect') this.apply(entry.defect);
      else this.applyComplete(entry.checkpoint);
    }
  }

  private persist(entry: LedgerEntry): void {
    if (!this.file) return;
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }

  private apply(defect: AuditDefect): void {
    this.recorded.push(defect);
    this.failed.add(defect.checkpoint);
    this.completed.delete(defect.checkpoint);
  }

  private applyComplete(checkpoint: string): void {
    if (this.failed.has(checkpoint)) return;
    this.completed.add(checkpoint);
  }

  /** Record a product defect. Persisted before it can be lost to a restart. */
  record(checkpoint: string, error: unknown): AuditDefect {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const summary = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);
    const defect: AuditDefect = { checkpoint, summary, detail };
    this.persist({ kind: 'defect', defect });
    this.apply(defect);
    return defect;
  }

  /** Mark a checkpoint completed. Refused if that checkpoint already failed. */
  complete(checkpoint: string): void {
    if (this.failed.has(checkpoint)) return;
    this.persist({ kind: 'complete', checkpoint });
    this.applyComplete(checkpoint);
  }

  get defects(): readonly AuditDefect[] {
    return [...this.recorded];
  }

  get completedCheckpoints(): readonly string[] {
    return [...this.completed].sort();
  }

  /**
   * The single gate a run must pass. Throws unless every expected checkpoint
   * completed AND no defect was recorded — reporting both halves at once, so a
   * partial run and a defective run are distinguishable in the same message.
   */
  assertClean(expectedCheckpoints: readonly string[]): void {
    const missing = expectedCheckpoints.filter((checkpoint) => !this.completed.has(checkpoint));
    if (missing.length === 0 && this.recorded.length === 0) return;

    const lines: string[] = [];
    if (this.recorded.length > 0) {
      lines.push(`${this.recorded.length} product defect(s):`);
      for (const defect of this.recorded) lines.push(`  - [${defect.checkpoint}] ${defect.summary}`);
    }
    if (missing.length > 0) {
      lines.push(`${missing.length} checkpoint(s) never completed: ${missing.join(', ')}`);
    }
    throw new AuditLedgerError(lines.join('\n'), this.defects, missing);
  }
}

// ============================================================================
// COUNT-TOLERANT TAB ASSERTIONS
// ============================================================================

export interface TabRowDelta {
  readonly added: string[];
  readonly removed: string[];
}

/**
 * Set difference between two snapshots of a tab's row identities.
 *
 * Identity, never count: the tab may legitimately gain or lose unrelated rows
 * mid-journey (a background sync, another operator, a sibling fixture), and a
 * count assertion cannot tell that apart from the mutation under test.
 */
export function diffTabRows(before: readonly string[], after: readonly string[]): TabRowDelta {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: [...afterSet].filter((row) => !beforeSet.has(row)).sort(),
    removed: [...beforeSet].filter((row) => !afterSet.has(row)).sort(),
  };
}

export interface OwnedMutationExpectation {
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
}

/**
 * Problems with a tab's own mutation, ignoring every unrelated change.
 *
 * Asserts the owned rows appear/disappear and that no row the journey owns moved
 * the wrong way. It deliberately does NOT require the delta to be exactly the
 * owned set — that would re-introduce the intolerance this replaces.
 */
export function ownedMutationProblems(
  before: readonly string[],
  after: readonly string[],
  expected: OwnedMutationExpectation
): string[] {
  const delta = diffTabRows(before, after);
  const problems: string[] = [];
  for (const row of expected.added ?? []) {
    if (!delta.added.includes(row)) {
      problems.push(
        after.includes(row)
          ? `"${row}" was already present before the mutation, so its appearance proves nothing`
          : `"${row}" never appeared in the tab after the mutation`
      );
    }
  }
  for (const row of expected.removed ?? []) {
    if (!delta.removed.includes(row)) {
      problems.push(
        before.includes(row) ? `"${row}" is still in the tab after removal` : `"${row}" was absent before removal`
      );
    }
  }
  for (const row of expected.added ?? []) {
    if (delta.removed.includes(row)) problems.push(`"${row}" was expected to appear but disappeared`);
  }
  for (const row of expected.removed ?? []) {
    if (delta.added.includes(row)) problems.push(`"${row}" was expected to disappear but appeared`);
  }
  return problems;
}

/**
 * Prove the tolerance is REAL rather than incidental: the tab must have changed
 * by more than the journey's own mutation, so a run in which nothing unrelated
 * moved cannot be presented as evidence that unrelated movement is tolerated.
 */
export function unrelatedChangeProblems(
  before: readonly string[],
  after: readonly string[],
  ownedRows: readonly string[]
): string[] {
  const delta = diffTabRows(before, after);
  const owned = new Set(ownedRows);
  const unrelated = [...delta.added, ...delta.removed].filter((row) => !owned.has(row));
  return unrelated.length > 0
    ? []
    : [
        'the tab saw no unrelated change during the journey, so count-tolerance was never exercised ' +
          `(added: ${JSON.stringify(delta.added)}, removed: ${JSON.stringify(delta.removed)})`,
      ];
}

// ============================================================================
// CAPTURED GRAPH IDENTITY
// ============================================================================

/** What the product wrote, captured from Firestore before any graph read. */
export interface CapturedRelationIdentity {
  readonly relationId: string;
  readonly sourceId: string;
  readonly sourceEntityType: string;
  readonly targetId: string;
  readonly targetEntityType: string;
  readonly predicate: string;
}

/** What Neo4j actually holds, read back by that captured identity. */
export interface ObservedGraphEdge {
  readonly relationId: string | null;
  readonly type: string;
  readonly startId: string;
  readonly endId: string;
  readonly startLabels: readonly string[];
  readonly endLabels: readonly string[];
}

/**
 * Every way a relation can have failed to converge, as a list so one run names
 * all of them.
 *
 * Checks the four things the row requires and the previous audit checked none of:
 * exact identity (the `relationId` the product minted, not "some edge exists"),
 * predicate, DIRECTION, and both endpoint LABELS — the last of which is what
 * stops a decoy internal-memory node from satisfying a convergence claim.
 */
export function relationConvergenceProblems(
  captured: CapturedRelationIdentity,
  edges: readonly ObservedGraphEdge[]
): string[] {
  const problems: string[] = [];
  const owned = edges.filter((edge) => edge.relationId === captured.relationId);

  if (owned.length === 0) {
    problems.push(`no Neo4j edge carries relationId ${captured.relationId}`);
    return problems;
  }
  if (owned.length > 1) {
    problems.push(`${owned.length} Neo4j edges carry relationId ${captured.relationId}; exactly one is required`);
  }

  const [edge] = owned;
  if (edge.type !== captured.predicate) {
    problems.push(`predicate is ${edge.type}, expected ${captured.predicate}`);
  }
  if (edge.startId !== captured.sourceId || edge.endId !== captured.targetId) {
    problems.push(
      `direction is ${edge.startId} -> ${edge.endId}, expected ${captured.sourceId} -> ${captured.targetId}`
    );
  }

  problems.push(...endpointLabelProblems('source', edge.startLabels, captured.sourceEntityType));
  problems.push(...endpointLabelProblems('target', edge.endLabels, captured.targetEntityType));
  return problems;
}

/** What the product wrote for an entity↔document link. */
export interface CapturedLinkIdentity {
  readonly linkId: string;
  readonly entityId: string;
  readonly entityEntityType: string;
  readonly documentId: string;
  readonly predicate: string;
}

/** Observed link edge, read back by the captured `linkId`. */
export interface ObservedLinkEdge {
  readonly linkId: string | null;
  readonly type: string;
  readonly startId: string;
  readonly endId: string;
  readonly startLabels: readonly string[];
  readonly endLabels: readonly string[];
}

export function linkConvergenceProblems(captured: CapturedLinkIdentity, edges: readonly ObservedLinkEdge[]): string[] {
  const problems: string[] = [];
  const owned = edges.filter((edge) => edge.linkId === captured.linkId);

  if (owned.length === 0) {
    problems.push(`no Neo4j edge carries linkId ${captured.linkId}`);
    return problems;
  }
  if (owned.length > 1) {
    problems.push(`${owned.length} Neo4j edges carry linkId ${captured.linkId}; exactly one is required`);
  }

  const [edge] = owned;
  if (edge.type !== captured.predicate) {
    problems.push(`predicate is ${edge.type}, expected ${captured.predicate}`);
  }
  if (edge.startId !== captured.entityId || edge.endId !== captured.documentId) {
    problems.push(
      `direction is ${edge.startId} -> ${edge.endId}, expected ${captured.entityId} -> ${captured.documentId}`
    );
  }

  problems.push(...endpointLabelProblems('entity', edge.startLabels, captured.entityEntityType));
  problems.push(...endpointLabelProblems('document', edge.endLabels, 'document'));
  return problems;
}

/**
 * An endpoint must be the canonical projection of the type the product claimed —
 * proven by LABEL (AI-026). A bookkeeping node that copied a business
 * `entityType` fails here, which is what makes the decoy control meaningful.
 */
function endpointLabelProblems(role: string, labels: readonly string[], entityType: string): string[] {
  const expected = graphLabelForEntityType(entityType);
  if (!expected) return [`${role} entity type ${entityType} has no canonical graph label`];
  if (!isBusinessEntityNode({ labels, properties: {} }, entityType)) {
    return [`${role} endpoint carries labels ${JSON.stringify(labels)}, which do not prove a ${entityType}`];
  }
  return [];
}

// ============================================================================
// CLEANUP
// ============================================================================

export interface ResidueCounts {
  readonly firestoreRelations: number;
  readonly firestoreLinks: number;
  readonly graphNodes: number;
  readonly graphEdges: number;
}

/**
 * Cleanup is an assertion, not a best effort. The previous audit's cleanup was
 * `.catch(() => {})`, so residue accumulated silently and a later run inherited
 * state its own preconditions then "proved".
 */
export function residueProblems(residue: ResidueCounts): string[] {
  return Object.entries(residue)
    .filter(([, count]) => count !== 0)
    .map(([kind, count]) => `${kind} left ${count} record(s) behind`);
}
