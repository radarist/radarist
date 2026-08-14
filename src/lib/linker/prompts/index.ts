/**
 * @file linker/prompts/index.ts
 * @description Prompt Versioning System for Linker Agent
 *
 * Provides versioned prompts for AI verification with:
 * - Version tracking for audit and debugging
 * - Easy A/B testing of prompt variations
 * - Rollback capability
 *
 * **Usage:**
 * ```typescript
 * import { getCurrentPromptVersion, getVerificationPrompt } from '@/lib/linker/prompts';
 *
 * const prompt = getVerificationPrompt(candidates);
 * console.log(`Using prompt version: ${getCurrentPromptVersion()}`);
 * ```
 *
 * @author Radarist Team
 * @created 2026-01-26
 */

import { createLogger } from '@/lib/logger';
import { buildVerificationPromptV1 } from './v1';

const log = createLogger('linker/prompts');
import type { LinkerCandidate } from '../types';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Prompt version metadata
 */
export interface PromptVersion {
  /** Version identifier (e.g., 'v1', 'v2') */
  version: string;

  /** ISO date when this version was created */
  createdAt: string;

  /** Brief description of changes */
  description: string;

  /** Whether this version is currently active */
  isActive: boolean;

  /** Performance metrics (if measured) */
  metrics?: {
    approvalRate?: number;
    precisionEstimate?: number;
    avgConfidence?: number;
  };
}

/**
 * Prompt builder function signature
 */
export type PromptBuilder = (candidates: LinkerCandidate[]) => string;

// ============================================================================
// VERSION REGISTRY
// ============================================================================

/**
 * Registry of all prompt versions
 */
export const PROMPT_VERSIONS: Record<string, PromptVersion> = {
  v1: {
    version: 'v1',
    createdAt: '2026-01-26',
    description: 'Initial production prompt with rich entity context and relation type guidance',
    isActive: true,
  },
};

/**
 * Map of version to builder function
 */
const PROMPT_BUILDERS: Record<string, PromptBuilder> = {
  v1: buildVerificationPromptV1,
};

/**
 * Current active version
 */
let CURRENT_VERSION = 'v1';

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Gets the current active prompt version.
 *
 * @returns Current version string (e.g., 'v1')
 */
export function getCurrentPromptVersion(): string {
  return CURRENT_VERSION;
}

/**
 * Sets the active prompt version.
 * Used for A/B testing or rolling back.
 *
 * @param version - Version to activate
 * @throws If version doesn't exist
 */
export function setPromptVersion(version: string): void {
  if (!PROMPT_VERSIONS[version]) {
    throw new Error(`Unknown prompt version: ${version}`);
  }
  CURRENT_VERSION = version;
  log.info('Switched to version', { version });
}

/**
 * Gets all available prompt versions.
 *
 * @returns Array of version metadata
 */
export function getAvailableVersions(): PromptVersion[] {
  return Object.values(PROMPT_VERSIONS);
}

/**
 * Gets metadata for a specific version.
 *
 * @param version - Version to look up
 * @returns Version metadata or undefined
 */
export function getVersionMetadata(version: string): PromptVersion | undefined {
  return PROMPT_VERSIONS[version];
}

/**
 * Builds a verification prompt using the current active version.
 *
 * @param candidates - Candidates to include in prompt
 * @returns Complete prompt string
 */
export function getVerificationPrompt(candidates: LinkerCandidate[]): string {
  const builder = PROMPT_BUILDERS[CURRENT_VERSION];
  if (!builder) {
    log.warn('No builder for version, falling back to v1', { version: CURRENT_VERSION });
    return buildVerificationPromptV1(candidates);
  }
  return builder(candidates);
}

/**
 * Builds a verification prompt using a specific version.
 * Useful for A/B testing.
 *
 * @param candidates - Candidates to include
 * @param version - Specific version to use
 * @returns Complete prompt string
 */
export function getVerificationPromptForVersion(candidates: LinkerCandidate[], version: string): string {
  const builder = PROMPT_BUILDERS[version];
  if (!builder) {
    throw new Error(`Unknown prompt version: ${version}`);
  }
  return builder(candidates);
}

/**
 * Updates metrics for a prompt version.
 * Called after runs to track performance.
 *
 * @param version - Version to update
 * @param metrics - Metrics to record
 */
export function updateVersionMetrics(version: string, metrics: Partial<PromptVersion['metrics']>): void {
  const versionData = PROMPT_VERSIONS[version];
  if (!versionData) {
    log.warn('Cannot update metrics for unknown version', { version });
    return;
  }

  versionData.metrics = {
    ...versionData.metrics,
    ...metrics,
  };

  log.info(`Updated metrics for ${version}`, metrics as Record<string, unknown>);
}

// ============================================================================
// EXPORTS
// ============================================================================

// Re-export v1 for direct access if needed
export { VERIFICATION_PROMPT_V1 } from './v1';
