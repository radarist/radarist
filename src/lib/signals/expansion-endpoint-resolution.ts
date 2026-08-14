/**
 * @file signals/expansion-endpoint-resolution.ts
 * @description Resolve or reject the endpoint IDs a signal expansion invents,
 * BEFORE they are persisted or scheduled for graph convergence (GRAPH-063).
 *
 * The expansion prompt asks the model for `relatedItems` entries shaped
 * `{"id": "tech-id", "name": "Tech Name", ...}`. Nothing grounds that `id` in
 * the workspace, so the model routinely emits plausible-looking identifiers for
 * entities that do not exist. Downstream, `buildImplicitRelationshipQueries`
 * turns each one into `MATCH (tech:Technology {id: $techId}) … MERGE`, which is
 * a successful Cypher execution with zero rows — an incomplete projection that
 * correctly refuses to stamp the entity's source fingerprint. For a phantom ID
 * that condition is PERMANENT: the signal never converges and the reconciler
 * replays it every cycle, forever.
 *
 * The fix is to decide the endpoint's fate at the point the expansion is
 * persisted, where the authoritative store is available:
 *
 *   - `kept`     — the ID names a real, projectable entity. Nothing to do.
 *   - `resolved` — the ID is wrong but the name matches exactly one real
 *                  entity. Rewrite the ID to the canonical one; the model got
 *                  the subject right and only the handle wrong.
 *   - `rejected` — nothing in the workspace answers to that ID or name, or the
 *                  target can never be projected. Drop the generated edge and
 *                  record why.
 *
 * After this pass every surviving ID exists in Firestore, so a later graph MATCH
 * miss means the projection is genuinely lagging — a transient condition that
 * SHOULD keep blocking the fingerprint until it converges.
 */

import { DIRECT_SIGNAL_GRAPH_STATUSES } from '@/lib/graph/signal-projection-policy';
import type { ExpandedContent } from '@/lib/schemas/signal';

export type RelatedItemKind = 'technologies' | 'companies' | 'signals';

export type EndpointResolutionOutcome = 'kept' | 'resolved' | 'rejected';

export type EndpointRejectionReason =
  'no-identifier' | 'unknown-id-and-name' | 'ambiguous-name' | 'not-projectable' | 'self-reference';

export interface ResolvedEndpoint {
  kind: RelatedItemKind;
  /** The ID the model produced. */
  proposedId: string;
  /** The display label the model produced (name for entities, title for signals). */
  proposedLabel: string;
  outcome: EndpointResolutionOutcome;
  /** Present when the endpoint survived: the ID that will be written. */
  canonicalId?: string;
  /** Present when the endpoint was dropped. */
  reason?: EndpointRejectionReason;
}

type RelatedItems = NonNullable<ExpandedContent['relatedItems']>;

export interface ExpansionEndpointResolution {
  /**
   * `relatedItems` with every surviving entry carrying a canonical ID. Absent
   * when the expansion produced none — declared optional (not `| undefined`) so
   * the shape survives Inngest's JSON round-trip of a memoized step result.
   */
  relatedItems?: RelatedItems;
  /** Every endpoint decision, in a stable order, for audit and telemetry. */
  decisions: ResolvedEndpoint[];
  keptCount: number;
  resolvedCount: number;
  rejectedCount: number;
}

/** One workspace entity as far as endpoint resolution is concerned. */
export interface CandidateEntity {
  id: string;
  label: string;
  /**
   * Whether this entity can ever appear in the graph. Signals are narrower than
   * the Firestore inbox (see DIRECT_SIGNAL_GRAPH_STATUSES); an inbox-only
   * signal would make the generated edge permanently unmatchable.
   */
  projectable: boolean;
}

/**
 * Reads the workspace's candidate entities for one kind. Injected so the pure
 * resolution logic stays testable and free of any Firestore import.
 */
export type CandidateLoader = (kind: RelatedItemKind) => Promise<CandidateEntity[]>;

const RELATED_ITEM_KINDS: RelatedItemKind[] = ['technologies', 'companies', 'signals'];

function normalizeLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function labelOf(item: Record<string, unknown>): string {
  // Technologies/companies carry `name`; signals carry `title`.
  const name = typeof item.name === 'string' ? item.name : '';
  const title = typeof item.title === 'string' ? item.title : '';
  return (name || title).trim();
}

/**
 * Decide the fate of every `relatedItems` endpoint against the authoritative
 * workspace, returning a canonicalized `relatedItems` plus the full decision log.
 *
 * @param expandedContent - the freshly generated expansion
 * @param signalId - the signal being expanded; a self-reference is dropped
 * @param loadCandidates - reads the workspace's entities for one kind
 */
export async function resolveExpansionEndpoints(
  expandedContent: ExpandedContent,
  signalId: string,
  loadCandidates: CandidateLoader
): Promise<ExpansionEndpointResolution> {
  const source = expandedContent.relatedItems;
  const decisions: ResolvedEndpoint[] = [];

  if (!source) {
    return { relatedItems: source, decisions, keptCount: 0, resolvedCount: 0, rejectedCount: 0 };
  }

  const survivors = {
    technologies: [] as RelatedItems['technologies'],
    companies: [] as RelatedItems['companies'],
    signals: [] as RelatedItems['signals'],
  };

  for (const kind of RELATED_ITEM_KINDS) {
    const items = (source[kind] ?? []) as unknown as Record<string, unknown>[];
    if (items.length === 0) continue;

    // Load lazily and once per kind: an expansion with no companies must not
    // pay for a company scan.
    const candidates = await loadCandidates(kind);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const byLabel = new Map<string, CandidateEntity[]>();
    for (const candidate of candidates) {
      const key = normalizeLabel(candidate.label);
      if (!key) continue;
      byLabel.set(key, [...(byLabel.get(key) ?? []), candidate]);
    }

    const seen = new Set<string>();
    for (const item of items) {
      const proposedId = normalizeId(item.id);
      const proposedLabel = labelOf(item);
      const record = (reason: EndpointRejectionReason) =>
        decisions.push({ kind, proposedId, proposedLabel, outcome: 'rejected', reason });

      if (!proposedId && !proposedLabel) {
        record('no-identifier');
        continue;
      }

      const direct = proposedId ? byId.get(proposedId) : undefined;
      let canonical = direct;
      let outcome: EndpointResolutionOutcome = 'kept';

      if (!canonical) {
        const matches = byLabel.get(normalizeLabel(proposedLabel)) ?? [];
        if (matches.length === 1) {
          canonical = matches[0];
          outcome = 'resolved';
        } else if (matches.length > 1) {
          // Two entities answer to the same name; picking one would be a guess.
          record('ambiguous-name');
          continue;
        } else {
          record('unknown-id-and-name');
          continue;
        }
      }

      if (!canonical.projectable) {
        record('not-projectable');
        continue;
      }
      if (canonical.id === signalId) {
        record('self-reference');
        continue;
      }
      // Canonicalization can collapse two model entries onto one entity.
      if (seen.has(canonical.id)) continue;
      seen.add(canonical.id);

      const canonicalized = { ...item, id: canonical.id };
      if (kind === 'signals') {
        survivors.signals.push(canonicalized as unknown as RelatedItems['signals'][number]);
      } else {
        survivors[kind].push(canonicalized as unknown as RelatedItems['technologies'][number]);
      }
      decisions.push({ kind, proposedId, proposedLabel, outcome, canonicalId: canonical.id });
    }
  }

  return {
    relatedItems: {
      ...source,
      technologies: survivors.technologies,
      companies: survivors.companies,
      signals: survivors.signals,
    },
    decisions,
    keptCount: decisions.filter((d) => d.outcome === 'kept').length,
    resolvedCount: decisions.filter((d) => d.outcome === 'resolved').length,
    rejectedCount: decisions.filter((d) => d.outcome === 'rejected').length,
  };
}

/**
 * Whether a signal document can ever be projected into the graph on its own.
 *
 * Mirrors `decideSignalProjection`'s direct-status arm. The reference arm is
 * deliberately NOT consulted: a `RELATED_SIGNAL` edge is not one of the
 * reference kinds that grants eligibility, so it cannot bootstrap its own
 * target into the graph.
 */
export function isDirectlyProjectableSignalStatus(status: unknown): boolean {
  return (DIRECT_SIGNAL_GRAPH_STATUSES as readonly string[]).includes(String(status));
}

/** Compact, bounded audit record stored on the signal for the rejected edges. */
export interface RejectedExpansionEndpoint {
  kind: RelatedItemKind;
  proposedId: string;
  proposedLabel: string;
  reason: EndpointRejectionReason;
}

/** Cap the persisted audit so a pathological expansion cannot bloat the document. */
export const MAX_PERSISTED_REJECTIONS = 25;

export function toPersistedRejections(decisions: readonly ResolvedEndpoint[]): RejectedExpansionEndpoint[] {
  return decisions
    .filter((decision) => decision.outcome === 'rejected')
    .slice(0, MAX_PERSISTED_REJECTIONS)
    .map((decision) => ({
      kind: decision.kind,
      proposedId: decision.proposedId,
      proposedLabel: decision.proposedLabel,
      reason: decision.reason ?? 'unknown-id-and-name',
    }));
}
