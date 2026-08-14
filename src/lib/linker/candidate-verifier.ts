/**
 * @file linker/candidate-verifier.ts
 * @description AI-powered Candidate Verification for Linker Agent
 *
 * Verifies relation candidates using Gemini AI to evaluate:
 * - Semantic validity of the proposed relation
 * - Confidence score adjustment
 * - Rejection reasoning for low-quality candidates
 *
 * **Features:**
 * - Batch processing for efficiency
 * - Structured output with Zod validation
 * - Confidence threshold filtering
 * - Detailed reasoning for transparency
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { createLogger } from '@/lib/logger';
import { z } from 'zod';

const log = createLogger('linker/candidate-verifier');
import { generateStructuredContent, type GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { getConfidenceThreshold, shouldUseGrounding, getVerificationStrategy } from './confidence-config';
import { getVerificationPrompt, getCurrentPromptVersion } from './prompts';
import type { LinkerCandidate } from './types';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Maximum candidates to process per AI batch
 */
const AI_BATCH_SIZE = 10;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Options for candidate verification
 */
export interface VerificationOptions {
  /** Minimum confidence threshold (0-100) */
  minConfidence?: number;
  /** Maximum candidates to verify */
  maxCandidates?: number;
}

/**
 * Verification result for a single candidate
 */
export interface VerificationResult {
  /** Whether the candidate was verified as valid */
  valid: boolean;
  /** Adjusted confidence score (0-100) */
  confidence: number;
  /** AI reasoning for the decision */
  reasoning: string;
  /** Suggested improvements (if confidence is borderline) */
  suggestions?: string[];
  /**
   * The verb the AI thinks should replace the input `relationType`,
   * when `relationCorrect === false`. Surfaced here (not just inside
   * the free-text `suggestions` array) so callers can write it back
   * to the candidate without parsing strings.
   */
  suggestedRelationType?: string;
}

// ============================================================================
// ZOD SCHEMAS
// ============================================================================

/**
 * Schema for single candidate verification
 */
const _CandidateVerificationSchema = z.object({
  isValid: z.boolean().describe('Whether this relation is semantically valid'),
  confidence: z.number().min(0).max(100).describe('Confidence score 0-100'),
  reasoning: z.string().describe('Brief explanation for the decision'),
  relationCorrect: z.boolean().describe('Whether the relation type is appropriate'),
  suggestedRelationType: z.string().optional().describe('Better relation type if current is wrong'),
});

/**
 * Schema for batch verification response
 */
const BatchVerificationSchema = z.object({
  verifications: z.array(
    z.object({
      candidateIndex: z.number().describe('Index of the candidate being verified'),
      isValid: z.boolean().describe('Whether this relation is valid'),
      confidence: z.number().min(0).max(100).describe('Confidence score 0-100'),
      reasoning: z.string().describe('Brief explanation for the decision'),
      relationCorrect: z.boolean().describe('Whether the relation type is appropriate'),
      suggestedRelationType: z.string().optional().describe('Better relation type if current is wrong'),
    })
  ),
});

type _BatchVerificationResponse = z.infer<typeof BatchVerificationSchema>;

// ============================================================================
// PROMPT BUILDING
// ============================================================================

// Note: Prompt building has been moved to src/lib/linker/prompts/ for versioning.
// The getVerificationPrompt() function from './prompts' now handles prompt construction.
// This allows tracking which prompt version was used for each verification run.

// ============================================================================
// VERIFICATION FUNCTIONS
// ============================================================================

/**
 * Options for batch verification
 */
interface BatchVerificationOptions {
  /** Enable Google Search grounding for web-verifiable relationships */
  useGrounding?: boolean;
}

/**
 * Verifies a batch of candidates using AI.
 *
 * @param candidates - Candidates to verify
 * @param options - Verification options (grounding, etc.)
 * @returns Verification results indexed by candidate
 */
async function verifyBatchWithAI(
  candidates: LinkerCandidate[],
  options: BatchVerificationOptions = {}
): Promise<Map<number, VerificationResult>> {
  const results = new Map<number, VerificationResult>();
  const { useGrounding = false } = options;

  if (candidates.length === 0) {
    return results;
  }

  try {
    // Use versioned prompt system
    const promptVersion = getCurrentPromptVersion();
    const prompt = getVerificationPrompt(candidates);

    log.info('Using prompt version', { promptVersion });

    const response = await generateStructuredContent(prompt, BatchVerificationSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.1, // Low temperature for consistent evaluation
      useGoogleSearch: useGrounding, // Enable web grounding when needed
    });

    if (useGrounding) {
      log.info('Using Google Search grounding', { candidates: candidates.length });
    }

    // Map results back to candidates. We carry `suggestedRelationType`
    // as a structured field AND keep the legacy `suggestions` array so
    // anything reading the old shape (logs, audit tools) still works.
    for (const verification of response.verifications) {
      results.set(verification.candidateIndex, {
        valid: verification.isValid,
        confidence: verification.confidence,
        reasoning: verification.reasoning,
        suggestions: verification.suggestedRelationType
          ? [`Consider relation type: ${verification.suggestedRelationType}`]
          : undefined,
        suggestedRelationType: verification.suggestedRelationType,
      });
    }

    return results;
  } catch (error) {
    log.error('AI verification failed', error instanceof Error ? error : undefined);

    // SAFE FALLBACK: Do NOT auto-approve when AI fails
    // This prevents low-quality candidates from being created
    candidates.forEach((candidate, index) => {
      results.set(index, {
        valid: false, // Reject - don't auto-approve
        confidence: 0, // Zero confidence
        reasoning: 'AI verification failed - candidate rejected for safety',
      });
    });

    // Log failure for monitoring
    log.warn('Rejected candidates due to AI failure', { count: candidates.length });

    return results;
  }
}

/**
 * Verifies candidates with AI and filters by confidence threshold.
 *
 * **Process:**
 * 1. Batch candidates for efficient AI processing
 * 2. Run AI verification on each batch
 * 3. Update confidence scores based on AI feedback
 * 4. Filter out candidates below threshold
 * 5. Optionally update relation types if AI suggests better ones
 *
 * @param candidates - Raw candidates from generator
 * @param options - Verification options
 * @returns Verified and filtered candidates
 *
 * @example
 * ```typescript
 * const verified = await verifyCandidatesWithAI(candidates, {
 *   minConfidence: 60,
 * });
 * ```
 */
export async function verifyCandidatesWithAI(
  candidates: LinkerCandidate[],
  options: VerificationOptions = {}
): Promise<LinkerCandidate[]> {
  const {
    minConfidence, // Now optional - will use entity-specific thresholds
    maxCandidates,
  } = options;

  log.info('Verifying candidates (using entity-specific thresholds)', { count: candidates.length });

  // Apply max limit if specified
  const toVerify = maxCandidates ? candidates.slice(0, maxCandidates) : candidates;

  if (toVerify.length === 0) {
    return [];
  }

  const verifiedCandidates: LinkerCandidate[] = [];

  // Separate candidates by grounding requirement for efficient batching
  const groundingCandidates = toVerify.filter((c) => shouldUseGrounding(c.sourceType, c.targetType));
  const contextCandidates = toVerify.filter((c) => !shouldUseGrounding(c.sourceType, c.targetType));

  log.info('Split candidates', { grounding: groundingCandidates.length, contextOnly: contextCandidates.length });

  // Process grounding candidates (slower, but more accurate for Company/Tech)
  if (groundingCandidates.length > 0) {
    const groundingResults = await processCandidateBatches(groundingCandidates, { useGrounding: true }, minConfidence);
    verifiedCandidates.push(...groundingResults);
  }

  // Process context-only candidates (faster)
  if (contextCandidates.length > 0) {
    const contextResults = await processCandidateBatches(contextCandidates, { useGrounding: false }, minConfidence);
    verifiedCandidates.push(...contextResults);
  }

  log.info('Verification complete', { passed: verifiedCandidates.length, total: candidates.length });

  return verifiedCandidates;
}

/**
 * Processes candidates in batches with specified options.
 * Uses entity-specific confidence thresholds.
 */
async function processCandidateBatches(
  candidates: LinkerCandidate[],
  batchOptions: BatchVerificationOptions,
  overrideMinConfidence?: number
): Promise<LinkerCandidate[]> {
  const verifiedCandidates: LinkerCandidate[] = [];

  for (let i = 0; i < candidates.length; i += AI_BATCH_SIZE) {
    const batch = candidates.slice(i, i + AI_BATCH_SIZE);
    const batchNum = Math.floor(i / AI_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(candidates.length / AI_BATCH_SIZE);

    log.info('Processing batch', { batch: batchNum, totalBatches, grounding: batchOptions.useGrounding });

    // Verify batch
    const results = await verifyBatchWithAI(batch, batchOptions);

    // Process results with entity-specific thresholds
    for (let j = 0; j < batch.length; j++) {
      const candidate = batch[j];
      const result = results.get(j);

      // Get entity-specific threshold (or use override if provided)
      const threshold = overrideMinConfidence ?? getConfidenceThreshold(candidate.sourceType, candidate.targetType);

      if (!result) {
        // No result - reject for safety (don't auto-approve)
        log.debug(`Rejected (no result): ${candidate.sourceName} -> ${candidate.targetName}`);
        continue;
      }

      // Check if valid and meets entity-specific threshold
      if (result.valid && result.confidence >= threshold) {
        // Update candidate with AI verification results, including any
        // refined relation type the AI proposed. Without this, the
        // verifier silently dropped suggestions on the floor — every
        // `custom` candidate was returning verified-but-unchanged, even
        // when the AI had named a proper verb (`narrows_to`, `vendor`,
        // …) in the response.
        const strategy = getVerificationStrategy(candidate.sourceType, candidate.targetType);
        const promptVersion = getCurrentPromptVersion();
        verifiedCandidates.push({
          ...candidate,
          confidence: result.confidence,
          suggestedRelationType: result.suggestedRelationType ?? candidate.suggestedRelationType,
          evidenceSnippets: [
            ...(candidate.evidenceSnippets || []),
            `AI verification (${strategy}, prompt:${promptVersion}): ${result.reasoning}`,
          ],
        });
      } else {
        log.debug(`Rejected: ${candidate.sourceName} -> ${candidate.targetName}`, {
          confidence: result.confidence,
          threshold,
          reason: result.reasoning,
        });
      }
    }
  }

  return verifiedCandidates;
}

/**
 * Verifies a single candidate (for UI/real-time use).
 * Uses grounding for Company/Technology relationships.
 *
 * @param candidate - Single candidate to verify
 * @returns Verification result
 */
export async function verifySingleCandidate(candidate: LinkerCandidate): Promise<VerificationResult> {
  const useGrounding = shouldUseGrounding(candidate.sourceType, candidate.targetType);
  const results = await verifyBatchWithAI([candidate], { useGrounding });

  return (
    results.get(0) || {
      valid: false, // Safe default: don't approve if verification failed
      confidence: 0,
      reasoning: 'Verification unavailable - candidate rejected for safety',
    }
  );
}

/**
 * Quick validation without AI (for pre-filtering).
 * Uses rule-based checks to reject obviously invalid candidates.
 *
 * @param candidate - Candidate to validate
 * @returns Whether candidate passes basic validation
 */
export function quickValidate(candidate: LinkerCandidate): boolean {
  // Rule 1: Source and target IDs must be different (self-reference check)
  if (candidate.sourceId === candidate.targetId) {
    return false;
  }

  // Rule 2: Same name (case-insensitive, trimmed) indicates likely duplicate entity
  // Even across types - e.g., "React" company and "React" technology might be data issues
  const sourceLower = candidate.sourceName?.toLowerCase().trim();
  const targetLower = candidate.targetName?.toLowerCase().trim();
  if (sourceLower && targetLower && sourceLower === targetLower) {
    return false;
  }

  // Rule 3: Must have minimum confidence
  if (candidate.confidence < 20) {
    return false;
  }

  // Rule 4: Must have names
  if (!candidate.sourceName || !candidate.targetName) {
    return false;
  }

  // Rule 5: Names shouldn't be too similar (likely duplicates or self-reference)
  // Check for substring relationships or very high similarity
  if (sourceLower && targetLower) {
    // If one name fully contains the other (same base entity)
    if (sourceLower.includes(targetLower) || targetLower.includes(sourceLower)) {
      // Only reject if they're the same type (e.g., "React" and "React Native" might be ok if different types)
      if (candidate.sourceType === candidate.targetType && Math.abs(sourceLower.length - targetLower.length) < 5) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Filters candidates using quick validation before AI verification.
 *
 * @param candidates - Candidates to filter
 * @returns Candidates that pass basic validation
 */
export function preFilterCandidates(candidates: LinkerCandidate[]): LinkerCandidate[] {
  const filtered = candidates.filter(quickValidate);

  if (filtered.length < candidates.length) {
    log.info('Pre-filter rejected candidates', { rejected: candidates.length - filtered.length });
  }

  return filtered;
}
