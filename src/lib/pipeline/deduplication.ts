/**
 * @file lib/pipeline/deduplication.ts
 * @description Entity deduplication service with fuzzy matching
 *
 * Identifies and merges duplicate entities across the platform using:
 * - Normalized string comparison
 * - Levenshtein distance (fuzzy matching)
 * - Domain-specific rules (company suffixes, tech abbreviations)
 *
 * **Algorithm:**
 * 1. Normalize entity names (lowercase, remove punctuation)
 * 2. Group by exact normalized match
 * 3. Fuzzy match remaining entities within similarity threshold
 * 4. Return canonical entity with list of duplicates
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

import type { ExtractedEntity } from './entity-extraction';

// ============================================================================
// TYPES
// ============================================================================

export interface DuplicateGroup {
  canonical: string;
  canonicalType: ExtractedEntity['type'];
  duplicates: Array<{
    name: string;
    similarity: number;
    matchReason: 'exact' | 'fuzzy' | 'alias' | 'abbreviation';
  }>;
  totalOccurrences: number;
  averageConfidence: number;
}

export interface DeduplicationResult {
  groups: DuplicateGroup[];
  totalEntities: number;
  uniqueEntities: number;
  duplicatesFound: number;
  processingTimeMs: number;
}

export interface DeduplicationOptions {
  similarityThreshold?: number;
  groupByType?: boolean;
  useAbbreviations?: boolean;
  useCompanySuffixes?: boolean;
}

// ============================================================================
// NORMALIZATION
// ============================================================================

/**
 * Common company suffixes to remove for matching.
 */
const COMPANY_SUFFIXES = [
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'llc',
  'ltd',
  'limited',
  'co',
  'company',
  'group',
  'holdings',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'srl',
  'bv',
  'nv',
];

/**
 * Common technology abbreviations and their expansions.
 */
const TECH_ABBREVIATIONS: Record<string, string[]> = {
  ai: ['artificial intelligence'],
  ml: ['machine learning'],
  dl: ['deep learning'],
  nlp: ['natural language processing'],
  cv: ['computer vision'],
  js: ['javascript'],
  ts: ['typescript'],
  py: ['python'],
  k8s: ['kubernetes'],
  tf: ['tensorflow'],
  aws: ['amazon web services'],
  gcp: ['google cloud platform'],
  azure: ['microsoft azure'],
  db: ['database'],
  sql: ['structured query language'],
  nosql: ['no sql', 'non relational'],
  api: ['application programming interface'],
  ui: ['user interface'],
  ux: ['user experience'],
  ci: ['continuous integration'],
  cd: ['continuous deployment', 'continuous delivery'],
  devops: ['development operations'],
  saas: ['software as a service'],
  paas: ['platform as a service'],
  iaas: ['infrastructure as a service'],
};

/**
 * Normalize a string for comparison.
 */
export function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a company name by removing common suffixes.
 */
export function normalizeCompanyName(name: string): string {
  let normalized = normalizeString(name);

  for (const suffix of COMPANY_SUFFIXES) {
    const pattern = new RegExp(`\\s+${suffix}$`, 'i');
    normalized = normalized.replace(pattern, '');
  }

  return normalized.trim();
}

/**
 * Get possible abbreviation expansions for a term.
 */
export function getAbbreviationExpansions(term: string): string[] {
  const normalized = term.toLowerCase();
  return TECH_ABBREVIATIONS[normalized] || [];
}

/**
 * Check if two terms are abbreviation matches.
 */
export function isAbbreviationMatch(term1: string, term2: string): boolean {
  const norm1 = normalizeString(term1);
  const norm2 = normalizeString(term2);

  // Check if term1 is abbreviation of term2
  const expansions1 = getAbbreviationExpansions(norm1);
  if (expansions1.some((e) => normalizeString(e) === norm2)) {
    return true;
  }

  // Check if term2 is abbreviation of term1
  const expansions2 = getAbbreviationExpansions(norm2);
  if (expansions2.some((e) => normalizeString(e) === norm1)) {
    return true;
  }

  return false;
}

// ============================================================================
// FUZZY MATCHING
// ============================================================================

/**
 * Calculate Levenshtein distance between two strings.
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Create matrix
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  // Initialize first row and column
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill in the rest
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Calculate similarity score between two strings (0-1).
 */
export function calculateSimilarity(str1: string, str2: string): number {
  const norm1 = normalizeString(str1);
  const norm2 = normalizeString(str2);

  if (norm1 === norm2) return 1;
  if (norm1.length === 0 || norm2.length === 0) return 0;

  const distance = levenshteinDistance(norm1, norm2);
  const maxLen = Math.max(norm1.length, norm2.length);

  return 1 - distance / maxLen;
}

/**
 * Check if two strings are similar above threshold.
 */
export function isSimilar(str1: string, str2: string, threshold: number): boolean {
  return calculateSimilarity(str1, str2) >= threshold;
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

/**
 * Find duplicate entities in a list.
 *
 * @example
 * ```typescript
 * const result = deduplicateEntities(entities, {
 *   similarityThreshold: 0.85,
 *   groupByType: true,
 * });
 * console.log(`Found ${result.duplicatesFound} duplicates in ${result.groups.length} groups`);
 * ```
 */
export function deduplicateEntities(
  entities: Array<ExtractedEntity & { signalIds?: string[] }>,
  options: DeduplicationOptions = {}
): DeduplicationResult {
  const startTime = Date.now();
  const {
    similarityThreshold = 0.85,
    groupByType = true,
    useAbbreviations = true,
    useCompanySuffixes = true,
  } = options;

  // Track which entities have been grouped
  const grouped = new Set<number>();
  const groups: DuplicateGroup[] = [];

  // Group entities
  const entitiesByType: Map<string, Array<{ index: number; entity: ExtractedEntity & { signalIds?: string[] } }>> =
    new Map();

  if (groupByType) {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const type = entity.type;
      if (!entitiesByType.has(type)) {
        entitiesByType.set(type, []);
      }
      entitiesByType.get(type)!.push({ index: i, entity });
    }
  } else {
    entitiesByType.set('all', entities.map((entity, index) => ({ index, entity })));
  }

  // Process each type group
  for (const [, typeEntities] of entitiesByType) {
    for (let i = 0; i < typeEntities.length; i++) {
      const { index: idx1, entity: entity1 } = typeEntities[i];
      if (grouped.has(idx1)) continue;

      const duplicates: DuplicateGroup['duplicates'] = [];
      let totalConfidence = entity1.confidence;
      let totalOccurrences = entity1.signalIds?.length || 1;

      // Normalize based on type
      const norm1 =
        entity1.type === 'company' && useCompanySuffixes
          ? normalizeCompanyName(entity1.name)
          : normalizeString(entity1.name);

      // Find duplicates
      for (let j = i + 1; j < typeEntities.length; j++) {
        const { index: idx2, entity: entity2 } = typeEntities[j];
        if (grouped.has(idx2)) continue;

        const norm2 =
          entity2.type === 'company' && useCompanySuffixes
            ? normalizeCompanyName(entity2.name)
            : normalizeString(entity2.name);

        // Check for exact match
        if (norm1 === norm2) {
          duplicates.push({
            name: entity2.name,
            similarity: 1,
            matchReason: 'exact',
          });
          grouped.add(idx2);
          totalConfidence += entity2.confidence;
          totalOccurrences += entity2.signalIds?.length || 1;
          continue;
        }

        // Check for abbreviation match (technologies only)
        if (useAbbreviations && entity1.type === 'technology') {
          if (isAbbreviationMatch(entity1.name, entity2.name)) {
            duplicates.push({
              name: entity2.name,
              similarity: 0.95,
              matchReason: 'abbreviation',
            });
            grouped.add(idx2);
            totalConfidence += entity2.confidence;
            totalOccurrences += entity2.signalIds?.length || 1;
            continue;
          }
        }

        // Check for alias match
        if (entity1.aliases?.some((a) => normalizeString(a) === norm2)) {
          duplicates.push({
            name: entity2.name,
            similarity: 1,
            matchReason: 'alias',
          });
          grouped.add(idx2);
          totalConfidence += entity2.confidence;
          totalOccurrences += entity2.signalIds?.length || 1;
          continue;
        }

        // Check for fuzzy match
        const similarity = calculateSimilarity(entity1.name, entity2.name);
        if (similarity >= similarityThreshold) {
          duplicates.push({
            name: entity2.name,
            similarity,
            matchReason: 'fuzzy',
          });
          grouped.add(idx2);
          totalConfidence += entity2.confidence;
          totalOccurrences += entity2.signalIds?.length || 1;
        }
      }

      // Create group (even if no duplicates, for consistent output)
      groups.push({
        canonical: entity1.name,
        canonicalType: entity1.type,
        duplicates,
        totalOccurrences,
        averageConfidence: Math.round(totalConfidence / (duplicates.length + 1)),
      });

      grouped.add(idx1);
    }
  }

  const duplicatesFound = groups.reduce((sum, g) => sum + g.duplicates.length, 0);

  return {
    groups,
    totalEntities: entities.length,
    uniqueEntities: groups.length,
    duplicatesFound,
    processingTimeMs: Date.now() - startTime,
  };
}

/**
 * Merge duplicate entities, keeping the one with highest confidence.
 */
export function mergeEntities(
  entities: Array<ExtractedEntity & { signalIds?: string[] }>,
  options: DeduplicationOptions = {}
): Array<ExtractedEntity & { signalIds: string[]; mergedFrom?: string[] }> {
  const deduped = deduplicateEntities(entities, options);

  return deduped.groups.map((group) => {
    // Find the original entity for this group
    const original = entities.find(
      (e) => normalizeString(e.name) === normalizeString(group.canonical)
    );

    const allSignalIds = new Set<string>();

    // Collect all signal IDs
    if (original?.signalIds) {
      for (const id of original.signalIds) {
        allSignalIds.add(id);
      }
    }

    // Collect signal IDs from duplicates
    for (const dup of group.duplicates) {
      const dupEntity = entities.find(
        (e) => normalizeString(e.name) === normalizeString(dup.name)
      );
      if (dupEntity?.signalIds) {
        for (const id of dupEntity.signalIds) {
          allSignalIds.add(id);
        }
      }
    }

    return {
      name: group.canonical,
      type: group.canonicalType,
      confidence: group.averageConfidence,
      signalIds: Array.from(allSignalIds),
      mergedFrom:
        group.duplicates.length > 0 ? group.duplicates.map((d) => d.name) : undefined,
    };
  });
}

/**
 * Get deduplication statistics.
 */
export function getDeduplicationStats(result: DeduplicationResult): {
  compressionRatio: number;
  duplicateRate: number;
  matchReasons: Record<string, number>;
} {
  const matchReasons: Record<string, number> = {
    exact: 0,
    fuzzy: 0,
    alias: 0,
    abbreviation: 0,
  };

  for (const group of result.groups) {
    for (const dup of group.duplicates) {
      matchReasons[dup.matchReason]++;
    }
  }

  return {
    compressionRatio:
      result.totalEntities > 0 ? result.uniqueEntities / result.totalEntities : 1,
    duplicateRate:
      result.totalEntities > 0 ? result.duplicatesFound / result.totalEntities : 0,
    matchReasons,
  };
}
