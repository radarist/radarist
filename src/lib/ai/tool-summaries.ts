/**
 * @file tool-summaries.ts
 * @description One-line, human-readable summaries for executed AI tool calls.
 *
 * Single source of truth for the per-tool summary wording — consumed by BOTH
 * the chat UI (AIMessage tool-call chips) and the /api/ai/chat route (fallback
 * message when tools ran but the model returned no text). The two surfaces
 * previously kept duplicate switches that drifted on five phrasings; this
 * module keeps the (shorter) client wording.
 *
 * Pure and isomorphic — no server-only or client-only imports.
 */

/** Structural view of a tool result (matches ToolResult in lib/ai/tools). */
export interface ToolCallResultLike {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Derives a one-line summary for an executed tool call from its result shape.
 *
 * @param name - Tool name (e.g. 'searchEntities').
 * @param args - The arguments the tool was called with (may be undefined).
 * @param result - The tool's result envelope; `undefined` (legacy persisted
 *   messages without results) yields an empty string.
 */
export function summarizeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  result: ToolCallResultLike | undefined
): string {
  if (!result) return '';
  const data = result.data;
  if (
    name === 'createRelation' &&
    typeof data === 'object' &&
    data !== null &&
    (data as { dispatched?: unknown }).dispatched === false
  ) {
    return 'Relationship not created';
  }
  if (!result.success) {
    return result.error || 'Failed';
  }

  switch (name) {
    case 'searchEntities': {
      const results = Array.isArray(data) ? data : ((data as { results?: unknown[] })?.results ?? []);
      return `Found ${results.length} ${String(args?.entityType ?? 'entities')}`;
    }
    case 'getEntityDetails':
      return `Retrieved details for ${(data as { name?: string })?.name || 'entity'}`;
    case 'createCompany':
    case 'createCompanyWithResearch':
      return `Created company: ${(data as { name?: string })?.name || 'new company'}`;
    case 'createTechnology':
    case 'createDecoupledTechnology':
      return `Created technology: ${(data as { name?: string })?.name || 'new technology'}`;
    case 'createUseCase':
      return `Created use case: ${(data as { title?: string })?.title || 'new use case'}`;
    case 'createPrototype':
      return `Created prototype: ${(data as { name?: string })?.name || 'new prototype'}`;
    case 'createStrategy':
      return `Created strategy: ${(data as { name?: string })?.name || 'new strategy'}`;
    case 'saveDiagram': {
      const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : '';
      return title ? `Saved “${title}” to Infographics` : 'Saved diagram to Infographics';
    }
    case 'updateEntity':
      return `Updated ${String(args?.entityType ?? 'entity')}`;
    case 'deleteEntity':
      return `Deleted ${String(args?.entityType ?? 'entity')}`;
    case 'createRelation': {
      const relationData = data as { dispatched?: boolean; created?: boolean; relationId?: string } | undefined;
      if (relationData?.dispatched === false) return 'Relationship not created';
      if (relationData?.created === false && relationData.relationId) {
        return 'Relationship already exists';
      }
      return 'Created relationship';
    }
    case 'createRelations': {
      // A batch is summarized by its receipt counts, never as a flat
      // "created": a partially refused bundle must read as partial.
      const batch = data as { requested?: number; linked?: number; refused?: number } | undefined;
      const requested = batch?.requested ?? 0;
      const linked = batch?.linked ?? 0;
      const refused = batch?.refused ?? 0;
      return refused > 0
        ? `Linked ${linked} of ${requested} relationships (${refused} not linked)`
        : `Linked ${linked} relationship${linked === 1 ? '' : 's'}`;
    }
    case 'proposeVerifiedRelation':
      if ((data as { dispatched?: boolean } | undefined)?.dispatched === false) {
        return 'Relationship already curated; no proposal created';
      }
      return 'Proposed relationship for review';
    case 'webSearch': {
      const searchData = data as { searchFailed?: boolean } | undefined;
      return searchData?.searchFailed ? 'Research completed with limited results' : 'Research completed';
    }
    case 'researchCompany':
    case 'researchTechnology':
      return 'Completed research';
    case 'researchTechnologyComprehensive': {
      const researchData = data as { status?: string; technologyName?: string; message?: string } | undefined;
      if (researchData?.status === 'pending') {
        return `Started research for ${researchData.technologyName || 'technology'}`;
      }
      return researchData?.message || 'Research initiated';
    }
    case 'listDocuments': {
      const docsData = data as { documents?: unknown[]; count?: number } | undefined;
      return `Found ${docsData?.count || docsData?.documents?.length || 0} documents`;
    }
    case 'searchDocuments': {
      const searchDocsData = data as { results?: unknown[] } | undefined;
      return `Found ${searchDocsData?.results?.length || 0} matching documents`;
    }
    case 'getDocumentDetails':
      return 'Retrieved document details';
    case 'captureEvidence':
      return 'Captured evidence link';
    case 'getChunkContent':
      return 'Retrieved document content';
    case 'searchDecoupledTechnologies': {
      const techResults = data as { results?: unknown[] } | undefined;
      return `Found ${techResults?.results?.length || 0} technologies`;
    }
    case 'placeTechnologyOnRadar':
      return 'Placed technology on radar';
    // Read-only graph payloads reach the summary through the shared normalized
    // `data` field rather than falling through to the generic completion label.
    case 'compareCompetitors': {
      const comparison = (data as { comparison?: { unique?: unknown[] } } | undefined)?.comparison;
      const count = comparison?.unique?.length ?? 0;
      return count > 0 ? `Compared ${count} unique technologies` : 'Compared competitor portfolios';
    }
    case 'recommendTechInvestments': {
      const recommendations = (data as { recommendations?: unknown[] } | undefined)?.recommendations;
      const count = recommendations?.length ?? 0;
      return count > 0 ? `Recommended ${count} technologies` : 'Recommended technologies';
    }
    // The visualization identity in `data` lets the chip confirm that the
    // artifact landed in the gallery instead of reading only "Completed".
    case 'generateVisualization': {
      const vizData = data as { visualizationId?: unknown } | undefined;
      return vizData?.visualizationId ? 'Saved visualization to Infographics' : 'Generated visualization';
    }
    default: {
      // Shape-based fallback: counts for arrays/search results, name for entities
      if (Array.isArray(data)) return `Returned ${data.length} results`;
      const generic = data as { results?: unknown[]; count?: number; name?: string } | undefined;
      if (Array.isArray(generic?.results)) return `Returned ${generic.results.length} results`;
      if (typeof generic?.count === 'number') return `Returned ${generic.count} results`;
      if (typeof generic?.name === 'string' && generic.name) return generic.name;
      return 'Completed';
    }
  }
}
