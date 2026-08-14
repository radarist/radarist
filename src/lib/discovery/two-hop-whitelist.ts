/**
 * @file discovery/two-hop-whitelist.ts
 * @description Per-source 2-hop join definitions for the transitive candidate
 * generator — the per-hop relation-type whitelist + direction + the proposed
 * relation it infers. Pure module (no graph/firebase imports).
 *
 * Verified against `src/lib/linker/relation-ontology.ts`: `technology-[SOLVES]->painPoint` (so
 * from a PainPoint the technology is the INCOMING SOLVES) and
 * `technology-[ADDRESSES]->useCase` (OUTGOING from the technology). The inferred
 * `painPoint-[addresses]->useCase` is itself a valid ontology pair.
 *
 * Rel-types are the UPPER Neo4j edge labels; `proposedRelationType` is the
 * lowercase the relation contract materializes. Only sources with a join here are
 * eligible — excluded sources (orgUnit/report/concept/…) have no key.
 */

export interface TwoHopEdge {
  /** UPPER Neo4j relationship labels to traverse for this hop. */
  relationTypes: string[];
  /** Direction relative to the hop's start node. */
  direction: 'incoming' | 'outgoing';
  /** entityType of the node this hop lands on. */
  targetLabel: string;
}

export interface TwoHopJoin {
  hop1: TwoHopEdge;
  hop2: TwoHopEdge;
  /** Lowercase relation the source→terminal candidate proposes. */
  proposedRelationType: string;
}

export const TWO_HOP_JOINS: Record<string, TwoHopJoin> = {
  // PainPoint —(incoming SOLVES)— Technology —(outgoing ADDRESSES)→ UseCase
  // ⇒ propose painPoint -[addresses]-> useCase.
  painPoint: {
    hop1: { relationTypes: ['SOLVES'], direction: 'incoming', targetLabel: 'technology' },
    hop2: { relationTypes: ['ADDRESSES'], direction: 'outgoing', targetLabel: 'useCase' },
    proposedRelationType: 'addresses',
  },
};

/** The 2-hop join for a source entityType, or undefined when none is whitelisted. */
export function getTwoHopJoin(entityType: string): TwoHopJoin | undefined {
  return TWO_HOP_JOINS[entityType];
}
