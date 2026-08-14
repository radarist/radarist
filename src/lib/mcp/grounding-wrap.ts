/**
 * @file mcp/grounding-wrap.ts
 * @description Scoped grounding wrap for fact-asserting MCP tools (L1).
 *
 * A SOFT, FAIL-OPEN post-wrap applied ONLY on the MCP transport, ONLY to an
 * EXPLICIT allow-list of fact-asserting read/query tools (`FACT_ASSERTING_TOOLS`
 * — graph + research readers). For an allow-listed tool whose result carries
 * load-bearing prose, it re-uses `generateGroundedContent` (`client.ts:399`) to
 * check whether that prose is backed by live web sources. If not, it PREPENDS a
 * human-visible "unverified" banner and stamps a metadata flag — it LABELS, it
 * never hard-blocks.
 *
 * Invariants:
 *  - Tools NOT in the allow-list pass through BYTE-IDENTICAL (same reference).
 *  - Error results, empty results, and too-short results pass through untouched
 *    (nothing fact-asserting to ground; keeps cost bounded to the named subset).
 *  - Any grounding failure (throw / malformed payload) FAILS OPEN — the original
 *    result is returned and the wrap never throws.
 *  - In-app chat / mission dispatch surfaces are untouched (this is wired into
 *    the MCP dispatch only, by the integration owner).
 *
 * @author Radarist Team
 * @created 2026-06-26
 */
import { generateGroundedContent } from '@/lib/ai/client';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp-grounding-wrap');

// ---------------------------------------------------------------------------
// Allow-list — EXPLICIT, named. We never *infer* "fact-asserting"; a tool only
// gets grounded if it is listed here. Membership is curated to read/query tools
// that emit external-world factual prose (graph knowledge readers + web/company
// /technology research). Mutation, schema, diagnostic, and citation-formatting
// tools are deliberately excluded.
// ---------------------------------------------------------------------------

export const FACT_ASSERTING_TOOLS: ReadonlySet<string> = new Set<string>([
  // --- Graph / knowledge readers (assert facts pulled from the graph) ---
  'askGraphQuestion',
  'queryGraph',
  'searchKnowledgeGraph',
  'getCommunityReports',
  'getTechSummary',
  'getEntityContext',
  'findEntitiesByMeaning',
  'compareCompetitors',
  'getGapAnalysis',
  'findVendors',
  'findSolutions',
  'findAlignedTechnologies',
  'getPersonalizedRecommendations',
  // --- Web / research readers (assert facts pulled from the open web) ---
  'webSearch',
  'webScrape',
  'researchWebPage',
  'researchTechnology',
  'researchCompanyByName',
  'researchCompanyComprehensive',
  'bulkResearchCompanies',
]);

/** Metadata key stamped onto a labelled result so downstream code can branch. */
export const GROUNDING_LABEL_META_KEY = '_grounding' as const;

/** Banner prepended to an ungrounded fact-asserting result. */
const UNGROUNDED_BANNER =
  '⚠️ UNVERIFIED — the factual claims below could not be confirmed against live web sources at retrieval time. Treat as ungrounded and verify before acting.';

// ---------------------------------------------------------------------------
// Tunables — bound the cost of the wrap to the named subset.
// ---------------------------------------------------------------------------

/** Below this many chars the result has no load-bearing prose worth grounding. */
const MIN_FACT_CHARS = 40;
/** Cap the prose sent to the grounding model — bounds worst-case token cost. */
const GROUNDING_INPUT_CAP = 4_000;

// ---------------------------------------------------------------------------
// MCP result shape (structural — mirrors server.ts:160-207). We type it loosely
// because the wrap receives `unknown` and must fail open on any other shape.
// ---------------------------------------------------------------------------

interface McpTextBlock {
  type: string;
  text: string;
}
interface McpToolResult {
  content?: McpTextBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

interface GroundingVerdict {
  grounded: boolean;
  checked: true;
  citationCount: number;
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as McpToolResult).content);
}

/** Concatenate the text blocks of an MCP result (best-effort). */
function extractText(result: McpToolResult): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .filter((b): b is McpTextBlock => !!b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Wrap a fact-asserting tool result with a SOFT grounding check.
 *
 * Returns the result UNCHANGED (same reference) for: non-allow-listed tools,
 * error/empty/too-short results, grounded results, and any grounding failure
 * (fail-open). Returns a NEW labelled object only when an allow-listed tool's
 * load-bearing prose comes back ungrounded.
 *
 * @param toolName - The MCP tool that produced `result`.
 * @param result  - The raw tool result to (conditionally) ground-check.
 */
export async function wrapFactAsserting(toolName: string, result: unknown): Promise<unknown> {
  // 1. Allow-list gate — anything not explicitly listed passes through.
  if (!FACT_ASSERTING_TOOLS.has(toolName)) {
    return result;
  }

  // 2. Shape gate — only ground MCP-shaped SUCCESS results with real prose.
  if (!isMcpToolResult(result) || result.isError) {
    return result;
  }

  const text = extractText(result);
  if (text.length < MIN_FACT_CHARS) {
    return result;
  }

  // 3. Grounding check — FAIL OPEN on any error or malformed payload.
  let verdict: GroundingVerdict;
  try {
    verdict = await assessGrounding(text);
  } catch (err) {
    log.warn('grounding check failed — fail-open (result returned unlabelled)', {
      tool: toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  if (verdict.grounded) {
    // Backed by live sources — nothing to flag, pass through untouched.
    return result;
  }

  log.info('ungrounded fact-asserting MCP result — labelling (soft)', {
    tool: toolName,
    citationCount: verdict.citationCount,
  });
  return labelUngrounded(result, verdict);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Ask the grounding model to corroborate the result's prose against live web
 * sources. We treat "grounded" as "the grounded generation surfaced at least
 * one real citation" — the same signal `generateGroundedContent` exposes. A
 * malformed payload (no `citations` array) is treated as a failure → fail-open
 * by throwing to the caller.
 */
async function assessGrounding(text: string): Promise<GroundingVerdict> {
  const capped = text.length > GROUNDING_INPUT_CAP ? text.slice(0, GROUNDING_INPUT_CAP) : text;
  const prompt =
    'Corroborate the factual claims in the following passage against current primary web sources. ' +
    'Cite the sources you find. If nothing supports the claims, say so.\n\nPASSAGE:\n' +
    capped;

  // AI-048 — this wrap only COUNTS citations; it never renders or persists their
  // URLs, so it opts out of publisher-identity resolution and pays no extra
  // round-trip. Every surface that does show or store a citation keeps the
  // default-on resolution in `generateGroundedContent`.
  const grounded = await generateGroundedContent(prompt, {
    skipReliability: true,
    citationResolution: { enabled: false },
  });

  // Defensive: a missing/!array `citations` means the grounding path returned
  // an unexpected shape — surface as a failure so the caller fails open.
  if (!grounded || !Array.isArray(grounded.citations)) {
    throw new Error('grounding returned a malformed payload (no citations array)');
  }

  const citationCount = grounded.citations.length;
  return { grounded: citationCount > 0, checked: true, citationCount };
}

/**
 * Return a NEW result that prepends the unverified banner as its own text block
 * (original blocks preserved, in order) and stamps the grounding verdict. The
 * input object is not mutated.
 */
function labelUngrounded(result: McpToolResult, verdict: GroundingVerdict): McpToolResult {
  const banner: McpTextBlock = { type: 'text', text: UNGROUNDED_BANNER };
  const originalContent = Array.isArray(result.content) ? result.content : [];
  return {
    ...result,
    content: [banner, ...originalContent],
    [GROUNDING_LABEL_META_KEY]: verdict,
  };
}
