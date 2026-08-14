/**
 * @file linker/confidence-config.ts
 * @description Entity-specific confidence thresholds for Linker verification
 *
 * Different entity combinations require different confidence levels:
 * - Company↔Company: Highest bar (80%) - competitors/partners need strong evidence
 * - Company↔Technology: High bar (75%) - vendor/user relationships
 * - Technology↔Technology: High bar (75%) - uses/competes relationships
 * - Signal↔Any: Lower bar (55-60%) - mentions are straightforward
 *
 * @author Radarist Team
 * @created 2026-01-26
 */


// ============================================================================
// CONFIDENCE THRESHOLDS
// ============================================================================

/**
 * Entity-specific confidence thresholds (0-100)
 * Higher values = stricter filtering
 */
export const CONFIDENCE_THRESHOLDS: Record<string, Record<string, number>> = {
  // Company relations - highest bar for business-critical relationships
  company: {
    company: 80,      // Competitors/partners need strong evidence
    technology: 75,   // Vendor/user relationships
    useCase: 70,
    signal: 60,
    document: 60,
    painPoint: 70,
    default: 70,
  },

  // Technology relations
  technology: {
    technology: 75,   // Uses/competes relationships need evidence
    company: 75,
    useCase: 70,
    signal: 60,
    document: 60,
    painPoint: 65,
    default: 65,
  },

  // Signal relations - lower bar (mentions are straightforward)
  signal: {
    company: 60,
    technology: 60,
    useCase: 55,
    painPoint: 55,
    document: 55,
    default: 55,
  },

  // Document relations
  document: {
    company: 65,
    technology: 65,
    useCase: 60,
    painPoint: 60,
    signal: 55,
    default: 60,
  },

  // UseCase relations
  useCase: {
    technology: 70,
    painPoint: 65,
    company: 70,
    signal: 60,
    document: 60,
    default: 65,
  },

  // PainPoint relations
  painPoint: {
    technology: 65,
    useCase: 65,
    company: 70,
    signal: 60,
    document: 60,
    default: 60,
  },

  // Prototype relations
  prototype: {
    technology: 65,
    company: 70,
    useCase: 65,
    default: 65,
  },

  // Strategy relations
  strategy: {
    technology: 70,
    company: 70,
    useCase: 65,
    initiative: 65,
    default: 65,
  },

  // Initiative relations
  initiative: {
    technology: 65,
    company: 65,
    useCase: 65,
    prototype: 60,
    default: 60,
  },

  // OrgUnit relations (internal entities)
  orgUnit: {
    company: 60,
    initiative: 55,
    default: 55,
  },
};

/**
 * Default threshold when no specific config exists
 */
const DEFAULT_THRESHOLD = 70;

// ============================================================================
// GROUNDING CONFIGURATION
// ============================================================================

/**
 * Entity type pairs that benefit from web grounding.
 * Only use grounding for public entities with verifiable web presence.
 */
const GROUNDING_PAIRS: Set<string> = new Set([
  'company:company',
  'company:technology',
  'technology:company',
  'technology:technology',
]);

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Gets the confidence threshold for a specific entity type pair.
 *
 * @param sourceType - Source entity type
 * @param targetType - Target entity type
 * @returns Confidence threshold (0-100)
 *
 * @example
 * ```typescript
 * const threshold = getConfidenceThreshold('company', 'company');
 * // Returns 80 (high bar for business relationships)
 * ```
 */
export function getConfidenceThreshold(
  sourceType: string,
  targetType: string
): number {
  const sourceConfig = CONFIDENCE_THRESHOLDS[sourceType];
  if (!sourceConfig) {
    return DEFAULT_THRESHOLD;
  }

  return sourceConfig[targetType] ?? sourceConfig.default ?? DEFAULT_THRESHOLD;
}

/**
 * Determines if web grounding should be used for verification.
 * Only recommended for public entity relationships that can be
 * verified through web search.
 *
 * @param sourceType - Source entity type
 * @param targetType - Target entity type
 * @returns Whether to use Google Search grounding
 *
 * @example
 * ```typescript
 * shouldUseGrounding('company', 'company');  // true - can verify competitors
 * shouldUseGrounding('signal', 'technology'); // false - use content analysis
 * ```
 */
export function shouldUseGrounding(
  sourceType: string,
  targetType: string
): boolean {
  const key = `${sourceType}:${targetType}`;
  return GROUNDING_PAIRS.has(key);
}

/**
 * Gets recommended verification strategy for an entity pair.
 *
 * @param sourceType - Source entity type
 * @param targetType - Target entity type
 * @returns Verification strategy
 */
export function getVerificationStrategy(
  sourceType: string,
  targetType: string
): 'grounding' | 'context' | 'content' {
  // Grounding for public entities
  if (shouldUseGrounding(sourceType, targetType)) {
    return 'grounding';
  }

  // Content analysis for signals/documents
  if (sourceType === 'signal' || sourceType === 'document') {
    return 'content';
  }

  // Context-based for internal entities
  return 'context';
}

/**
 * Gets all entity pairs that require high confidence (>= 75%).
 * Useful for highlighting business-critical relationships.
 *
 * @returns Array of [sourceType, targetType] pairs
 */
export function getHighConfidencePairs(): [string, string][] {
  const pairs: [string, string][] = [];

  for (const [sourceType, targetConfig] of Object.entries(CONFIDENCE_THRESHOLDS)) {
    for (const [targetType, threshold] of Object.entries(targetConfig)) {
      if (targetType !== 'default' && threshold >= 75) {
        pairs.push([sourceType, targetType]);
      }
    }
  }

  return pairs;
}
