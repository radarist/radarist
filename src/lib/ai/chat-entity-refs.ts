/**
 * @file chat-entity-refs.ts
 * @description Derives entity-chip references for AI chat responses from the
 * tool results of the turn.
 *
 * The chat UI (AIMessage) renders clickable entity chips from
 * `message.entities`, but `parseAIResponse()` never populated that field — the
 * chips were dead UI. Entity-shaped tool results already carry exactly the
 * references the chips need, so we derive them here instead of asking the
 * model to emit structured entity lists. Three result shapes are covered:
 *
 * 1. `data.results: [{ id, name, type }]` — searchEntities, listEntities,
 *    searchOrgUnits, searchDecoupledTechnologies, … (flat search results);
 * 2. `data.entities: [{ id, name, type }]` — searchKnowledgeGraph matches;
 * 3. `data.related: { companies/technologies/useCases: [{ id, name }] }` —
 *    getRelatedEntities, where the object key supplies the entity type.
 *
 * Dedupe (by type+id) and the MAX_ENTITY_REFS cap apply across ALL sources.
 */

import type { ClaimChip } from '@/lib/claim-chips';

export interface ChatEntityRef {
  type: string;
  id: string;
  name: string;
}

/** Minimal structural view of an executed tool call (matches ToolResult). */
export interface ChatToolCall {
  name: string;
  result: { success: boolean; data?: unknown; error?: string };
}

/** Cap so a broad listEntities call doesn't flood the message with chips. */
const MAX_ENTITY_REFS = 8;

/** `data.related` key → navigable entity type (getRelatedEntities shape). */
const RELATED_KEY_TYPES: Record<string, string> = {
  companies: 'company',
  technologies: 'technology',
  useCases: 'useCase',
};

/**
 * Collects unique `{type, id, name}` references from successful tool results.
 * Only items that structurally look like platform entities (string id, name,
 * and type — or a type supplied by a known `data.related` key) qualify —
 * web-search results (title/url) are filtered out by the shape check. Returns
 * undefined when nothing qualifies so the response JSON omits the field
 * entirely.
 */
export function extractEntityRefs(toolCalls: ChatToolCall[]): ChatEntityRef[] | undefined {
  const refs: ChatEntityRef[] = [];
  const seen = new Set<string>();

  /** Adds a ref unless it's a duplicate; returns false once the cap is hit. */
  const addRef = (type: string, id: string, name: string): boolean => {
    const key = `${type}:${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ type, id, name });
    }
    return refs.length < MAX_ENTITY_REFS;
  };

  /** Scans an array of items carrying their own `type` field. */
  const collectTypedItems = (items: unknown[]): boolean => {
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, name, type } = item as Record<string, unknown>;
      if (typeof id !== 'string' || typeof name !== 'string' || typeof type !== 'string') continue;
      if (!id || !name || !type) continue;
      if (!addRef(type, id, name)) return false;
    }
    return true;
  };

  /** Scans `data.related` arrays where the object key supplies the type. */
  const collectRelatedItems = (type: string, items: unknown[]): boolean => {
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, name } = item as Record<string, unknown>;
      if (typeof id !== 'string' || typeof name !== 'string') continue;
      if (!id || !name) continue;
      if (!addRef(type, id, name)) return false;
    }
    return true;
  };

  for (const call of toolCalls) {
    if (!call.result?.success) continue;
    const data = call.result.data as { results?: unknown; entities?: unknown; related?: unknown } | null | undefined;
    if (!data || typeof data !== 'object') continue;

    // Shape 1: flat search results with per-item type
    if (Array.isArray(data.results) && !collectTypedItems(data.results)) return refs;

    // Shape 2: knowledge-graph entity matches (same per-item structural check)
    if (Array.isArray(data.entities) && !collectTypedItems(data.entities)) return refs;

    // Shape 3: getRelatedEntities — the related-map key supplies the type
    if (data.related && typeof data.related === 'object' && !Array.isArray(data.related)) {
      for (const [key, items] of Object.entries(data.related as Record<string, unknown>)) {
        const type = RELATED_KEY_TYPES[key];
        if (!type || !Array.isArray(items)) continue;
        if (!collectRelatedItems(type, items)) return refs;
      }
    }
  }

  return refs.length > 0 ? refs : undefined;
}

/** A web source surfaced from a grounded web-search tool result. */
export interface ChatCitation {
  uri: string;
  title?: string;
  /**
   * AI-048 — publisher URL recovered from a Google grounding redirect. The UI
   * links and labels with this; `uri` stays the provider-supplied URL.
   */
  identityUri?: string;
}

/** Cap so a chatty web search doesn't flood the Sources block. */
const MAX_CITATIONS = 10;

/**
 * Phase 2.1 (Part D) — collects the real web sources Gemini grounded on, from
 * any successful tool result carrying `data.citations` (the grounded webSearch
 * shape). Capped. Returns undefined when there are none, so the response JSON
 * omits the field and the UI renders no Sources block.
 *
 * AI-048 — deduped by PUBLISHER IDENTITY where one was recovered. Gemini can
 * return two distinct grounding redirects for the same article, so deduping on
 * the raw uri would list one publisher twice in the Sources block — the display
 * twin of the corroboration inflation GRAPH-070 closes.
 */
export function extractCitations(toolCalls: ChatToolCall[]): ChatCitation[] | undefined {
  const out: ChatCitation[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (!call.result?.success) continue;
    const data = call.result.data as { citations?: unknown } | null | undefined;
    if (!data || typeof data !== 'object' || !Array.isArray(data.citations)) continue;
    for (const c of data.citations) {
      if (typeof c !== 'object' || c === null) continue;
      const { uri, title, identityUri } = c as Record<string, unknown>;
      if (typeof uri !== 'string' || !uri) continue;
      const resolvedIdentity = typeof identityUri === 'string' && identityUri ? identityUri : undefined;
      const dedupeKey = resolvedIdentity ?? uri;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        uri,
        title: typeof title === 'string' ? title : undefined,
        ...(resolvedIdentity ? { identityUri: resolvedIdentity } : {}),
      });
      if (out.length >= MAX_CITATIONS) return out;
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Cap so a chatty turn doesn't flood the response with corroboration chips. */
const MAX_CLAIM_CHIPS = 6;

const CLAIM_CHIP_KINDS = new Set(['curated', 'corroborated', 'single', 'unverified']);

/** Structural guard — a tool result field only counts as a chip if it has every ClaimChip field. */
function isClaimChip(value: unknown): value is ClaimChip {
  if (typeof value !== 'object' || value === null) return false;
  const { relationId, statement, kind, independentSourceCount } = value as Record<string, unknown>;
  return (
    typeof relationId === 'string' &&
    !!relationId &&
    typeof statement === 'string' &&
    typeof kind === 'string' &&
    CLAIM_CHIP_KINDS.has(kind) &&
    typeof independentSourceCount === 'number'
  );
}

/**
 * Task 9 (C3b) — collects corroboration/curation trust chips (★/✓✓/✓/○) that
 * the assertion tools attach TOP-LEVEL on their result — `evidence.claimChip`
 * (executeGetRelationEvidence) and `explanation.chip` (executeExplainRelation)
 * — NOT under `data`, unlike the entity/citation shapes above. Deduped by
 * relationId, capped, and returns undefined when none qualify so the response
 * JSON omits the field entirely (mirrors extractCitations).
 */
export function extractClaimChips(toolCalls: ChatToolCall[]): ClaimChip[] | undefined {
  const out: ClaimChip[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (!call.result?.success) continue;
    const result = call.result as unknown as Record<string, unknown>;
    const evidence = result.evidence as Record<string, unknown> | undefined;
    const explanation = result.explanation as Record<string, unknown> | undefined;
    const chip = evidence?.claimChip ?? explanation?.chip;
    if (!isClaimChip(chip) || seen.has(chip.relationId)) continue;
    seen.add(chip.relationId);
    out.push(chip);
    if (out.length >= MAX_CLAIM_CHIPS) return out;
  }
  return out.length > 0 ? out : undefined;
}
