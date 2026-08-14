/**
 * @file lib/mission-fact-check.ts
 * @description Quality Layer 1.5 — external claim verification ("the fact-check").
 *
 * L1 (`mission-quality.ts`) checks citation *discipline* — does a `[3]` exist,
 * is it padded. L2 (`mission-quality-llm.ts`) is an LLM grading the text, which
 * shares the author's blind spot. NEITHER verifies a claim's *value* against the
 * outside world, so a confident, cited, self-graded fabrication
 * ("Majorana-1 = 32 logical qubits"; real chip ≈ 8 physical) sails through every
 * gate and ships.
 *
 * This module closes that gap. For a published report it:
 *   1. extracts the load-bearing, externally-checkable specifics (numbers, dates,
 *      named-entity facts) — explicitly EXCLUDING forecasts/opinions/hedged claims,
 *   2. re-verifies each via live Google Search grounding (a NEUTRAL question that
 *      does not echo the draft value),
 *   3. judges each confirmed / contradicted / unverifiable (biased toward
 *      `unverifiable` to avoid false positives),
 *   4. returns ONE soft `QualityCheck` (`report-claims-verified`).
 *
 * The check is SOFT (non-critical) and FAIL-OPEN: a contradiction flips the
 * mission verdict to REVISE (one corrective pass through the existing Step 2.75
 * loop), and ANY infrastructure failure (no API key, grounding outage, zero
 * checkable claims) resolves to PASS — fact-check infra never blocks a ship.
 * This mirrors the design-pass SOFT publish-gate precedent.
 */
import { z } from 'zod';
import { generateContentWithMetadata, generateStructuredContentWithMetadata, type GeminiModel } from '@/lib/ai/client';
import { createLogger } from '@/lib/logger';
import type { QualityCheck } from '@/lib/mission-quality';

const log = createLogger('mission-fact-check');

// ---------------------------------------------------------------------------
// Tunables (env-overridable)
// ---------------------------------------------------------------------------

/** Max load-bearing claims verified per report — caps grounding cost. */
const MAX_CLAIMS = clampInt(process.env.FACT_CHECK_MAX_CLAIMS, 8, 1, 20);
/** Below this length the artifact is too small to be a report worth checking. */
const MIN_REPORT_CHARS = clampInt(process.env.FACT_CHECK_MIN_REPORT_CHARS, 800, 0, 100_000);
/** Cap report text sent to the extractor — bounds worst-case token cost. */
const EXTRACT_INPUT_CAP_BYTES = 48 * 1024;
/** Cap each grounded snippet fed to the judge — bounds judge token cost. */
const GROUNDED_SNIPPET_CAP = 2_000;
/** Concurrent grounding searches — polite to the rate limiter (30 RPM). */
const GROUNDING_CONCURRENCY = 3;
/** Per-claim grounding wall-clock cap — a single hung search can't stall the run. */
const GROUNDING_TIMEOUT_MS = clampInt(process.env.FACT_CHECK_GROUNDING_TIMEOUT_MS, 20_000, 500, 120_000);
/** Total grounding-phase wall-clock budget — remaining claims short-circuit to unverifiable. */
const TOTAL_TIMEOUT_MS = clampInt(process.env.FACT_CHECK_TOTAL_TIMEOUT_MS, 120_000, 1_000, 600_000);
/** Grounding model — matches the gemini-grounding MCP default. */
const GROUNDING_MODEL = (process.env.FACT_CHECK_MODEL ?? 'gemini-3-flash-preview') as GeminiModel;
/** Extraction/judge model — cheap text default is fine; these don't search. */
const REASONING_MODEL = (process.env.FACT_CHECK_REASONING_MODEL ?? 'gemini-3.5-flash') as GeminiModel;

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const extractedClaimSchema = z.object({
  text: z.string().describe('The claim as written, trimmed.'),
  subject: z.string().describe('The named entity the claim is about.'),
  value: z.string().describe('The specific value asserted (number/date/fact).'),
  hasCitation: z.boolean().describe('Does the claim already carry a [N] citation?'),
  verificationQuestion: z
    .string()
    .describe('A neutral question answerable from a primary source that does NOT reveal the asserted value.'),
});

// `generateStructuredContent` runs Gemini in JSON mode with NO native response
// schema (it only `schema.parse()`s the parsed JSON), and the prompt is the
// model's only shape hint. For a wrapper object whose sole field is an array,
// the model frequently returns the BARE array instead. Tolerate both shapes via
// a preprocess so a stray array doesn't fail extraction/judging open every time.
const extractionSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { claims: v } : v),
  z.object({ claims: z.array(extractedClaimSchema) })
);

const verdictItemSchema = z.object({
  index: z.number().int().describe('0-based index of the claim being judged.'),
  status: z.enum(['confirmed', 'contradicted', 'unverifiable']),
  groundedValue: z.string().optional().describe('For contradicted claims: the corrected value the sources support.'),
  note: z.string().describe('One-line rationale, citing the source phrase/URL when contradicted.'),
});

// MISSION-008: the judge response is parsed PERMISSIVELY — a truncated or
// partially-malformed verdict array must never fail the whole fact-check open
// and erase the grounded evidence. The schema keeps each item as `unknown` (so
// `schema.parse` cannot throw on a bad item), and `salvageVerdicts` re-validates
// each item individually, keeping the well-formed ones and dropping the rest.
const verdictSchema = z.preprocess(
  (v) => {
    if (Array.isArray(v)) return { verdicts: v };
    if (v && typeof v === 'object' && Array.isArray((v as { verdicts?: unknown }).verdicts)) return v;
    return { verdicts: [] };
  },
  z.object({ verdicts: z.array(z.unknown()) })
);

export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;
export type ClaimVerdict = z.infer<typeof verdictItemSchema>;

/**
 * Re-validate a raw judge verdict list item-by-item, keeping only well-formed
 * verdicts and dropping malformed/partial ones. This is what lets a truncated
 * judge payload that still contains one valid `contradicted` verdict surface
 * that contradiction instead of the whole result being discarded fail-open.
 */
export function salvageVerdicts(raw: unknown[]): ClaimVerdict[] {
  const out: ClaimVerdict[] = [];
  for (const item of raw) {
    const parsed = verdictItemSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** A claim paired with its grounded search result, ready for judging. */
export interface VerifiedClaim {
  claim: ExtractedClaim;
  grounded: string;
}

export interface FactCheckResult {
  /** The soft QualityCheck to fold into the mission's quality report. */
  check: QualityCheck;
  /** Structured detail for logging / auditing (not persisted to the report). */
  claimsChecked: number;
  contradicted: number;
  unverifiable: number;
  confirmed: number;
  /**
   * MISSION-008: extracted claims dropped BEFORE grounding because they carry
   * internal-shape markers (local IDs, telemetry, audit timestamps, internal
   * model/agent labels) — not externally checkable, never sent to public search.
   */
  excluded: number;
  /** True when the check resolved fail-open (infra issue / nothing to check). */
  failedOpen: boolean;
  /** MISSION-005: real Gemini spend of this fact-check (extraction +
   * grounding + judging), for the mission cost breakdown. Includes whatever
   * was spent before a fail-open. */
  costUsd: number | null;
}

export const FACT_CHECK_NAME = 'report-claims-verified';

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface FactCheckInput {
  /** The published report's full text/HTML. */
  reportText: string;
  /** Override the claim cap (tests / cost control). */
  maxClaims?: number;
  /** Override the per-claim grounding timeout (tests / cost control). */
  groundingTimeoutMs?: number;
  /** Override the total grounding-phase wall-clock budget (tests / cost control). */
  totalTimeoutMs?: number;
  /** Correlation id for logs. */
  missionId?: string;
}

/**
 * Fact-check a published report's load-bearing claims via grounded search.
 * Always resolves (never throws): infrastructure failures resolve fail-open
 * (PASS). Returns the soft `report-claims-verified` QualityCheck plus a
 * structured summary for logging.
 */
export async function runReportFactCheck(input: FactCheckInput): Promise<FactCheckResult> {
  const maxClaims = input.maxClaims ?? MAX_CLAIMS;
  const text = (input.reportText ?? '').trim();
  // MISSION-005: real Gemini spend accumulated across all three phases and
  // carried on EVERY return path (a fail-open after extraction still spent).
  let costUsd: number | null = 0;

  if (text.length < MIN_REPORT_CHARS) {
    return failOpen(`report too short to fact-check (${text.length} < ${MIN_REPORT_CHARS} chars)`, costUsd);
  }

  let claims: ExtractedClaim[];
  try {
    const extraction = await extractLoadBearingClaims(text, maxClaims);
    claims = extraction.claims;
    costUsd = addCost(costUsd, extraction.costUsd);
  } catch (err) {
    log.warn('fact-check extraction failed — fail-open', {
      missionId: input.missionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return failOpen('claim extraction unavailable', costUsd);
  }

  if (claims.length === 0) {
    return failOpen('no load-bearing checkable claims found', costUsd);
  }

  // MISSION-008: deterministic, no-cost partition BEFORE any public grounding.
  // Internal-shape "facts" (local IDs, telemetry, audit timestamps, internal
  // model/agent labels) are never externally checkable — dropping them here
  // stops internal detail from leaking to public Google Search and stops the
  // grounder from returning noise for un-searchable strings.
  const { checkable, excluded } = partitionExternallyCheckable(claims);
  if (excluded.length > 0) {
    log.info('fact-check excluded internal-shape claims from grounding', {
      missionId: input.missionId,
      excluded: excluded.length,
      reasons: excluded.map((e) => e.reason),
    });
  }
  const excludedCount = excluded.length;

  if (checkable.length === 0) {
    return failOpen('no externally-checkable claims (all internal references)', costUsd, excludedCount);
  }

  const groundingTimeoutMs = input.groundingTimeoutMs ?? GROUNDING_TIMEOUT_MS;
  const totalDeadline = Date.now() + (input.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);

  let verified: VerifiedClaim[];
  try {
    const grounding = await groundClaims(checkable, groundingTimeoutMs, totalDeadline);
    verified = grounding.verified;
    costUsd = addCost(costUsd, grounding.costUsd);
  } catch (err) {
    log.warn('fact-check grounding failed — fail-open', {
      missionId: input.missionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return failOpen('grounding search unavailable', costUsd, excludedCount);
  }

  // If every grounding call came back empty (outage / quota), we have nothing
  // to judge against — fail-open rather than invent contradictions.
  if (verified.every((v) => v.grounded.trim().length === 0)) {
    return failOpen('grounding returned no results', costUsd, excludedCount);
  }

  let verdicts: ClaimVerdict[];
  try {
    const judged = await judgeClaims(verified);
    verdicts = judged.verdicts;
    costUsd = addCost(costUsd, judged.costUsd);
  } catch (err) {
    // A genuine API/JSON hard-failure of the judge call (the content path is
    // salvaged inside judgeClaims and does NOT throw). Do NOT discard the
    // grounded evidence: assemble a partial result where every grounded claim
    // degrades to `unverifiable` — worst case per claim, never total erasure.
    log.warn('fact-check judging failed — degrading grounded claims to unverifiable', {
      missionId: input.missionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return buildResult(verified, [], costUsd, excludedCount, input.missionId);
  }

  return buildResult(verified, verdicts, costUsd, excludedCount, input.missionId);
}

// ---------------------------------------------------------------------------
// Step 1 — extract
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are preparing a fact-check of a published research report. Extract the LOAD-BEARING, EXTERNALLY-CHECKABLE factual claims — the specific values a reader would act on that could be proven right or wrong by a web search right now.

INCLUDE:
- Specific quantities about named real-world entities: product/chip/model specs (qubit counts, parameter counts, context windows, benchmark scores), market sizes / CAGR / revenue / headcount, release dates, precedence claims ("X overtook / was first / shipped before Y in YYYY"), named technical standards mapped to a value.

EXCLUDE (do NOT extract):
- Forecasts or predictions about the future (e.g. "commercial advantage by 2029–2032"), even when dated — these are hedged opinions, not checkable facts.
- Subjective or strategic judgments, recommendations, framing language.
- Claims already explicitly hedged or tagged: [assumption], [estimate], "reportedly", "likely", "~", "approximately".
- Vague or round framing numbers with no decision weight.
- INTERNAL platform references, which are not answerable by the public web: local record IDs (UUIDs, "mission-…"/"run_…"/doc-id strings), internal HTTP status/error codes (a local 404/500, ECONNREFUSED, localhost), system/audit timestamps (createdAt/updatedAt/ISO instants), platform telemetry (token counts, costUsd, durationMs, latency), and internal model/agent/codename labels ("model used was …", agent profile names).

For EACH extracted claim provide:
- text: the claim as written (trimmed).
- subject: the named entity it is about.
- value: the specific value asserted.
- hasCitation: whether it already carries a [N]-style citation.
- verificationQuestion: a NEUTRAL question a third party could answer from a primary source, which does NOT contain the asserted value. Ask "how many… / what is… / when did…", never "is it true that…".

Return at most {{maxClaims}} claims, ranked by decision weight. If the document contains no such checkable specifics, return an empty list.

Respond with ONE JSON object of the form {"claims": [ {...}, ... ]}. Always wrap the list under the "claims" key — never return a bare array. If there are no claims, return {"claims": []}.

DOCUMENT:
{{document}}`;

async function extractLoadBearingClaims(
  text: string,
  maxClaims: number
): Promise<{ claims: ExtractedClaim[]; costUsd: number | null }> {
  const doc = text.length > EXTRACT_INPUT_CAP_BYTES ? text.slice(0, EXTRACT_INPUT_CAP_BYTES) : text;
  const prompt = EXTRACTION_PROMPT.replace('{{maxClaims}}', String(maxClaims)).replace('{{document}}', doc);

  const result = await generateStructuredContentWithMetadata(prompt, extractionSchema, {
    model: REASONING_MODEL,
    temperature: 0.1,
    maxOutputTokens: 4096,
    skipReliability: true, // best-effort, like the L2 judge — don't trip the breaker
  });

  return { claims: result.data.claims.slice(0, maxClaims), costUsd: result.costUsd };
}

// ---------------------------------------------------------------------------
// Step 2 — ground (live Google Search per claim)
// ---------------------------------------------------------------------------

async function groundClaims(
  claims: ExtractedClaim[],
  perClaimTimeoutMs: number,
  totalDeadline: number
): Promise<{ verified: VerifiedClaim[]; costUsd: number | null }> {
  let costUsd: number | null = 0;
  const verified = await mapWithConcurrency(claims, GROUNDING_CONCURRENCY, async (claim) => {
    // Total-budget short-circuit: once the phase deadline passes, remaining
    // claims degrade to "no result" (→ unverifiable) instead of extending the run.
    if (Date.now() >= totalDeadline) {
      log.debug('grounding total budget exhausted — claim degraded to unverifiable', {
        subject: claim.subject,
      });
      return { claim, grounded: '' };
    }

    const outcome = await raceTimeout(
      generateContentWithMetadata(claim.verificationQuestion, {
        model: GROUNDING_MODEL,
        useGoogleSearch: true,
        maxOutputTokens: 2048,
      }),
      perClaimTimeoutMs
    );

    if (outcome.ok) {
      costUsd = addCost(costUsd, outcome.value.costUsd);
      return { claim, grounded: outcome.value.text ?? '' };
    }
    // A per-claim timeout or one failed search shouldn't sink the batch — treat
    // as "no result" (→ judged unverifiable, never a false contradiction).
    log.debug(`grounding ${outcome.reason} for one claim`, {
      subject: claim.subject,
      ...(outcome.reason === 'error'
        ? { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }
        : {}),
    });
    return { claim, grounded: '' };
  });
  return { verified, costUsd };
}

// ---------------------------------------------------------------------------
// Step 3 — judge (batched)
// ---------------------------------------------------------------------------

const JUDGE_PROMPT = `You are fact-checking a report. For each claim you are given the claim as written, the asserted value, and the result of a LIVE web search (with sources) for a neutral question about it.

Classify each claim:
- "confirmed": the search results state the SAME specific value as the claim.
- "contradicted": the search results state a CLEARLY DIFFERENT specific value. Use this ONLY when a source asserts a different specific number/date/fact — never when the results are merely silent, fuzzy, or about something adjacent.
- "unverifiable": the results are ambiguous, mixed, empty, or do not state a specific value.

CRITICAL: when you are unsure whether a claim is contradicted or unverifiable, choose "unverifiable". A false "contradicted" causes a needless rewrite that can introduce errors. Only "contradicted" when the grounded evidence is specific and clearly different.

A claim that is a FORECAST or prediction about the FUTURE (e.g. "by 2030", "will reach", "expected to") is not externally checkable today — classify it "unverifiable", never "contradicted", even if today's sources show different current values.

For "contradicted" claims you MUST set groundedValue to the corrected specific value the sources support, and cite the source phrase or URL in note. If you cannot name a specific corrected value, the claim is "unverifiable", not "contradicted".

Return one verdict per claim, with the matching 0-based index.

Respond with ONE JSON object of EXACTLY this shape:
{"verdicts": [{"index": <0-based number>, "status": "confirmed" | "contradicted" | "unverifiable", "groundedValue": "<corrected value — include ONLY when contradicted>", "note": "<one-line rationale; cite the source phrase or URL>"}, ...]}
Every verdict object MUST include "index", "status", and "note" (groundedValue only when contradicted). Always wrap the list under the "verdicts" key — never return a bare array.

CLAIMS AND SEARCH RESULTS:
{{payload}}`;

async function judgeClaims(
  verified: VerifiedClaim[]
): Promise<{ verdicts: ClaimVerdict[]; costUsd: number | null }> {
  const payload = verified
    .map((v, i) => {
      const grounded =
        v.grounded.length > GROUNDED_SNIPPET_CAP ? v.grounded.slice(0, GROUNDED_SNIPPET_CAP) : v.grounded;
      return [
        `[${i}] CLAIM: ${v.claim.text}`,
        `    ASSERTED VALUE: ${v.claim.value}`,
        `    SEARCH RESULT: ${grounded.trim() || '(no result)'}`,
      ].join('\n');
    })
    .join('\n\n');

  const prompt = JUDGE_PROMPT.replace('{{payload}}', payload);
  const result = await generateStructuredContentWithMetadata(prompt, verdictSchema, {
    model: REASONING_MODEL,
    temperature: 0.1,
    maxOutputTokens: 4096,
    skipReliability: true,
  });
  // The schema keeps items as `unknown`; salvage the well-formed verdicts and
  // drop malformed/partial ones. Cost is folded regardless of how many items
  // survived — the judge tokens were spent whether or not every item parsed.
  const rawVerdicts = (result.data as { verdicts: unknown[] }).verdicts;
  return { verdicts: salvageVerdicts(rawVerdicts), costUsd: result.costUsd };
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function buildResult(
  verified: VerifiedClaim[],
  verdicts: ClaimVerdict[],
  costUsd: number | null,
  excluded: number,
  missionId?: string
): FactCheckResult {
  const byIndex = new Map<number, ClaimVerdict>();
  for (const v of verdicts) byIndex.set(v.index, v);

  // Observability: surface judge degradation. Out-of-range indices are dropped
  // (the claim falls back to unverifiable below), and a short verdict list can
  // mean the judge timed out / truncated — both silently bias toward
  // unverifiable, so a real grounding signal could be lost. Warn, don't block.
  const outOfRange = verdicts.filter((v) => v.index < 0 || v.index >= verified.length);
  if (outOfRange.length > 0) {
    log.warn('fact-check judge returned out-of-range verdict indices', {
      missionId,
      outOfRange: outOfRange.length,
      claims: verified.length,
    });
  }
  if (verdicts.length < Math.ceil(verified.length * 0.8)) {
    log.warn('fact-check judge returned fewer verdicts than claims — possible judge degradation', {
      missionId,
      verdicts: verdicts.length,
      claims: verified.length,
    });
  }

  const contradicted: Array<{ claim: ExtractedClaim; verdict: ClaimVerdict }> = [];
  const unverifiable: Array<{ claim: ExtractedClaim; verdict: ClaimVerdict }> = [];
  let confirmed = 0;

  verified.forEach((v, i) => {
    // A claim with no verdict (model dropped it) is treated as unverifiable,
    // never as a pass and never as a contradiction.
    const verdict = byIndex.get(i) ?? { index: i, status: 'unverifiable' as const, note: 'no verdict returned' };
    if (verdict.status === 'contradicted') contradicted.push({ claim: v.claim, verdict });
    else if (verdict.status === 'unverifiable') unverifiable.push({ claim: v.claim, verdict });
    else confirmed += 1;
  });

  const claimsChecked = verified.length;
  const pass = contradicted.length === 0;
  const detail = formatDetail({ claimsChecked, confirmed, contradicted, unverifiable, excluded });

  log.info('fact-check complete', {
    missionId,
    claimsChecked,
    confirmed,
    contradicted: contradicted.length,
    unverifiable: unverifiable.length,
    excluded,
    verdict: pass ? 'PASS' : 'REVISE',
  });

  return {
    check: { name: FACT_CHECK_NAME, pass, critical: false, detail },
    claimsChecked,
    confirmed,
    contradicted: contradicted.length,
    unverifiable: unverifiable.length,
    excluded,
    failedOpen: false,
    costUsd,
  };
}

/** Build the actionable `detail` string consumed by build-feedback. */
function formatDetail(args: {
  claimsChecked: number;
  confirmed: number;
  contradicted: Array<{ claim: ExtractedClaim; verdict: ClaimVerdict }>;
  unverifiable: Array<{ claim: ExtractedClaim; verdict: ClaimVerdict }>;
  excluded: number;
}): string {
  const { claimsChecked, confirmed, contradicted, unverifiable, excluded } = args;
  // Excluded internal-shape claims are reported for transparency but are never
  // a defect — they simply aren't answerable by the public web.
  const excludedNote =
    excluded > 0 ? ` (${excluded} internal-reference claim(s) excluded as not externally checkable)` : '';
  if (contradicted.length === 0) {
    const tail = unverifiable.length > 0 ? `; ${unverifiable.length} unverifiable (advisory)` : '';
    return `${claimsChecked} load-bearing claim(s) re-checked via live grounding — ${confirmed} confirmed, 0 contradicted${tail}${excludedNote}.`;
  }

  const lines: string[] = [
    `${contradicted.length} load-bearing claim(s) CONTRADICTED by live grounded sources — correct EACH to the grounded value before re-publishing (do not ship the original number):`,
  ];
  contradicted.forEach((c, idx) => {
    // Always actionable: name the asserted value to replace and the correction
    // target. groundedValue is the ideal target, but the schema allows it to be
    // absent — fall back to the (required) note, which the judge is told to use
    // for the corrected value + source, so feedback is never just "you're wrong".
    const corrected = c.verdict.groundedValue?.trim();
    const target = corrected ? `grounded value: ${corrected}` : 'grounded sources disagree — re-verify and correct';
    lines.push(`  ${idx + 1}. "${c.claim.text}" (asserted: ${c.claim.value}) → ${target}. ${c.verdict.note}`);
  });
  if (unverifiable.length > 0) {
    lines.push(
      `Also ${unverifiable.length} unverifiable claim(s) — hedge ("reportedly"/"as of YYYY") or tag [estimate]; do not present as confirmed fact:`
    );
    unverifiable.forEach((c, idx) => {
      lines.push(`  ${idx + 1}. "${c.claim.text}". ${c.verdict.note}`);
    });
  }
  lines.push('Method: each claim re-verified via live Google Search grounding (search_with_grounding).');
  return lines.join('\n');
}

/** A check that passes without blocking — infra failure or nothing to verify. */
function failOpen(reason: string, costUsd: number | null = 0, excluded = 0): FactCheckResult {
  return {
    check: {
      name: FACT_CHECK_NAME,
      pass: true,
      critical: false,
      detail: `Fact-check not run (${reason}); shipping without external claim verification.`,
      // REPORT-003: this pass evaluated nothing — never a promotion baseline.
      notEvaluated: true,
    },
    claimsChecked: 0,
    confirmed: 0,
    contradicted: 0,
    unverifiable: 0,
    excluded,
    failedOpen: true,
    costUsd,
  };
}

/** A single unpriced paid component makes the aggregate unavailable. */
function addCost(current: number | null, next: number | null): number | null {
  return current === null || next === null ? null : current + next;
}

// ---------------------------------------------------------------------------
// MISSION-008 — deterministic externally-checkable partition
// ---------------------------------------------------------------------------

/**
 * Internal-shape signals. A claim matching ANY of these describes the
 * platform's OWN operation (identifiers, network/HTTP errors, machine
 * timestamps, telemetry, internal model/agent provenance) rather than a fact
 * about the outside world, so it is neither answerable by public search nor
 * safe to send there. Kept intentionally specific so genuine external product
 * facts (a named entity + a spec/market/date value) are preserved.
 */
const INTERNAL_SHAPE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  // Opaque local identifiers.
  ['uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  [
    'prefixed-id',
    /\b(mission|run|sig|signal|tech|technology|rel|relation|doc|document|radar|company|placement|assertion|episode|agent|user|job|artifact)[-_](?=[a-z0-9-]{6,}\b)[a-z0-9-]*\d[a-z0-9-]*\b/i,
  ],
  ['long-hex', /\b[0-9a-f]{16,}\b/i],
  // Internal network / HTTP error surface.
  ['localhost', /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b/i],
  ['node-errno', /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EADDRINUSE|EPIPE|ERR_[A-Z_]+)\b/],
  [
    // A 4xx/5xx only counts as internal when it sits in an explicit HTTP/error
    // context — NOT a bare "returned 500 million users" / "returned a 450% gain",
    // which are external facts the fact-check should still verify.
    'http-status',
    /\bHTTP\s?[45]\d\d\b|\b[45]\d\d\s+(error|status|response|not\s+found)\b|\b(returned|threw|got|responded(?:\s+with)?)\s+(a\s+)?(HTTP\s?)?[45]\d\d\s+(error|status|response|not\s+found)\b|\blocal\s+[45]\d\d\b/i,
  ],
  ['internal-route', /(^|[\s"'(<])\/(api|admin|debug|internal|_next)\/[a-z0-9]/i],
  // Machine timestamps (ISO instant, or audit field names).
  ['iso-instant', /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/],
  [
    'audit-field',
    /\b(created|updated|detected|archived|generated|started|completed|executed|evaluated|invalidated|observed|snapshot)At\b|\bt_(observed|valid|invalidated)\b|\blast[- ]?seen\b/i,
  ],
  // Platform telemetry.
  [
    'telemetry-metric',
    /\b(cost_?usd|duration_?ms|latency_?ms|prompt_?tokens|completion_?tokens|input_?tokens|output_?tokens|queue_?depth|requests?_per_minute)\b|\btokens?_?(used|consumed|spent|remaining)\b/i,
  ],
  [
    'token-usage',
    /\b(used|consumed|spent)\s+[\d,]+\s+tokens?\b|\b[\d,]+\s+tokens?\s+(used|consumed|spent|remaining)\b/i,
  ],
  // Internal run/model provenance phrasing + codenames. Narrow to "…used was/
  // were …" (this run's own model, e.g. "research model used was MUZZLE") so it
  // does NOT swallow external product claims like "the model used by OpenAI" or
  // "the model named AlphaFold 3". The codename catch is the backstop.
  ['run-provenance', /\b(model|agent|profile|orchestrator|pipeline)\s+used\s+(was|were)\b/i],
  ['internal-codename', /\bMUZZLE\b/],
];

/** A 20-char token mixing lower+upper+digit is a Firestore auto-id shape. */
function hasFirestoreLikeId(haystack: string): boolean {
  const tokens = haystack.match(/\b[A-Za-z0-9]{20}\b/g) ?? [];
  return tokens.some((t) => /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t));
}

/** First internal-shape marker found in a claim, or null if externally checkable. */
function internalShapeReason(claim: ExtractedClaim): string | null {
  const haystack = `${claim.text}\n${claim.subject}\n${claim.value}\n${claim.verificationQuestion}`;
  for (const [label, re] of INTERNAL_SHAPE_PATTERNS) {
    if (re.test(haystack)) return label;
  }
  if (hasFirestoreLikeId(haystack)) return 'firestore-id';
  return null;
}

/**
 * Partition extracted claims into those safe/useful to ground against public
 * search vs. internal-reference claims to drop. Synchronous and no-cost — this
 * is the load-bearing guarantee that internal data never reaches Google (the
 * extraction prompt's EXCLUDE list is only a best-effort first pass).
 */
export function partitionExternallyCheckable(claims: ExtractedClaim[]): {
  checkable: ExtractedClaim[];
  excluded: Array<{ claim: ExtractedClaim; reason: string }>;
} {
  const checkable: ExtractedClaim[] = [];
  const excluded: Array<{ claim: ExtractedClaim; reason: string }> = [];
  for (const claim of claims) {
    const reason = internalShapeReason(claim);
    if (reason) excluded.push({ claim, reason });
    else checkable.push(claim);
  }
  return { checkable, excluded };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

type RaceOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'error'; error?: unknown };

/**
 * Resolve with the promise's value, or a bounded outcome if it rejects or
 * outruns `ms`. Never rejects — a hung grounding call resolves `timeout` so the
 * worker pool advances instead of stalling the whole fact-check.
 */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<RaceOutcome<T>> {
  return new Promise<RaceOutcome<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'timeout' });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: 'error', error });
      }
    );
  });
}

/** Map with a fixed concurrency ceiling, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
