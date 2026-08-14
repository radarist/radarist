/**
 * @file lib/fuzzy-search.ts
 * @description Fuzzy/similarity search utilities for finding items by partial matches
 *
 * This module provides fuzzy matching that:
 * 1. Tokenizes search queries into individual words
 * 2. Supports partial word matching (prefix matching)
 * 3. Handles hyphenated terms (e.g., "AI-driven")
 * 4. Ranks normalized exact and prefix matches before fuzzy relevance
 * 5. Calculates relevance scores for ranking remaining results
 * 6. Is case-insensitive and handles special characters
 *
 * @example
 * ```typescript
 * const results = fuzzySearch(items, 'AI prediction', {
 *   keys: ['name', 'description'],
 *   threshold: 0.3,
 * });
 * ```
 *
 * @author Radarist Team
 * @created 2026-01-12
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * Options for fuzzy search
 */
export interface FuzzySearchOptions<T> {
  /** Keys/fields to search in; the first key receives exact/prefix precedence */
  keys?: (keyof T)[];
  /** Minimum score threshold (0-1, default: 0.2) */
  threshold?: number;
  /** Maximum results to return */
  limit?: number;
  /** Whether to return scores with results */
  includeScore?: boolean;
}

/**
 * Result with score for ranked results
 */
export interface FuzzySearchResult<T> {
  item: T;
  score: number;
  matchedTerms: string[];
}

type RankedFuzzySearchResult<T> = FuzzySearchResult<T> & {
  matchPrecedence: number;
};

// ============================================================================
// TEXT NORMALIZATION
// ============================================================================

/**
 * Normalize text for fuzzy matching:
 * - Convert to lowercase
 * - Handle hyphenated words (split and keep both)
 * - Remove special characters except spaces
 * - Collapse multiple spaces
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    // Replace hyphens with spaces but also keep the hyphenated version
    .replace(/-/g, ' ')
    // Remove special characters except alphanumeric and spaces
    .replace(/[^a-z0-9\s]/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize text into searchable terms
 * - Splits on whitespace
 * - Removes empty tokens
 * - Returns unique tokens
 */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  const tokens = normalized.split(' ').filter(t => t.length > 0);
  // Return unique tokens
  return [...new Set(tokens)];
}

// ============================================================================
// MATCHING FUNCTIONS
// ============================================================================

/**
 * Check if a query token matches a text token
 * Supports:
 * - Exact match
 * - Prefix match (query is start of text token)
 * - Contains match (query is contained in text token)
 */
export function tokenMatches(queryToken: string, textToken: string): boolean {
  // Exact match
  if (queryToken === textToken) return true;

  // Prefix match (e.g., "pred" matches "prediction")
  if (textToken.startsWith(queryToken) && queryToken.length >= 2) return true;

  // Contains match (e.g., "flavor" matches "ai-flavor")
  if (textToken.includes(queryToken) && queryToken.length >= 3) return true;

  return false;
}

/**
 * Calculate match score for a single query token against text
 * Returns 1.0 for exact match, 0.8 for prefix, 0.6 for contains, 0 for no match
 */
export function tokenMatchScore(queryToken: string, textToken: string): number {
  if (queryToken === textToken) return 1.0;
  if (textToken.startsWith(queryToken) && queryToken.length >= 2) return 0.8;
  if (textToken.includes(queryToken) && queryToken.length >= 3) return 0.6;
  return 0;
}

/**
 * Calculate overall match score for a query against text
 * Returns a score between 0 and 1 based on:
 * - How many query tokens match
 * - Quality of each match (exact > prefix > contains)
 */
export function calculateMatchScore(query: string, text: string): { score: number; matchedTerms: string[] } {
  const queryTokens = tokenize(query);
  const textTokens = tokenize(text);

  if (queryTokens.length === 0 || textTokens.length === 0) {
    return { score: 0, matchedTerms: [] };
  }

  let totalScore = 0;
  const matchedTerms: string[] = [];

  for (const queryToken of queryTokens) {
    let bestScore = 0;
    let bestMatch = '';

    for (const textToken of textTokens) {
      const score = tokenMatchScore(queryToken, textToken);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = textToken;
      }
    }

    if (bestScore > 0) {
      totalScore += bestScore;
      matchedTerms.push(bestMatch);
    }
  }

  // Normalize by number of query tokens
  const normalizedScore = totalScore / queryTokens.length;

  // Boost score if more text tokens match
  const coverageBonus = Math.min(matchedTerms.length / textTokens.length, 0.2);

  return {
    score: Math.min(normalizedScore + coverageBonus, 1.0),
    matchedTerms: [...new Set(matchedTerms)],
  };
}

/**
 * Rank whole-field matches ahead of token-level fuzzy matches.
 * Normalization makes case, punctuation, and whitespace differences equivalent.
 */
function getMatchPrecedence(query: string, text: string): number {
  const normalizedQuery = normalizeText(query);
  const normalizedText = normalizeText(text);

  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedText === normalizedQuery) return 2;
  if (normalizedText.startsWith(normalizedQuery)) return 1;
  return 0;
}

function compareRankedResults<T>(a: RankedFuzzySearchResult<T>, b: RankedFuzzySearchResult<T>): number {
  return b.matchPrecedence - a.matchPrecedence || b.score - a.score;
}

function rankObjectResults<T extends object>(
  items: T[],
  query: string,
  keys: (keyof T)[],
  threshold: number
): RankedFuzzySearchResult<T>[] {
  const results: RankedFuzzySearchResult<T>[] = [];

  for (const item of items) {
    let bestScore = 0;
    let bestMatchedTerms: string[] = [];
    const precedenceValue = item[keys[0]];
    const matchPrecedence = typeof precedenceValue === 'string' ? getMatchPrecedence(query, precedenceValue) : 0;

    for (const key of keys) {
      const value = item[key];
      if (typeof value === 'string') {
        const { score, matchedTerms } = calculateMatchScore(query, value);
        if (score > bestScore) {
          bestScore = score;
          bestMatchedTerms = matchedTerms;
        }
      }
    }

    if (bestScore >= threshold) {
      results.push({ item, score: bestScore, matchedTerms: bestMatchedTerms, matchPrecedence });
    }
  }

  return results.sort(compareRankedResults);
}

// ============================================================================
// MAIN SEARCH FUNCTIONS
// ============================================================================

/**
 * Perform fuzzy search on an array of strings
 *
 * @param items - Array of strings to search
 * @param query - Search query
 * @param options - Search options
 * @returns Matched items sorted by exact/prefix precedence, then score
 *
 * @example
 * ```typescript
 * const names = ['React', 'React Native', 'Angular', 'Vue.js'];
 * const results = fuzzySearchStrings(names, 'react');
 * // Returns: ['React', 'React Native']
 * ```
 */
export function fuzzySearchStrings(
  items: string[],
  query: string,
  options: Omit<FuzzySearchOptions<string>, 'keys'> = {}
): string[] {
  const threshold = options.threshold ?? 0.2;
  const limit = options.limit;

  const results: RankedFuzzySearchResult<string>[] = [];

  for (const item of items) {
    const { score, matchedTerms } = calculateMatchScore(query, item);
    if (score >= threshold) {
      results.push({ item, score, matchedTerms, matchPrecedence: getMatchPrecedence(query, item) });
    }
  }

  results.sort(compareRankedResults);

  // Apply limit
  const limited = limit ? results.slice(0, limit) : results;

  return limited.map(r => r.item);
}

/**
 * Perform fuzzy search on an array of objects
 *
 * @param items - Array of objects to search
 * @param query - Search query
 * @param options - Search options with keys to search
 * @returns Matched items sorted by exact/prefix precedence, then score
 *
 * @example
 * ```typescript
 * const technologies = [
 *   { name: 'AI-driven Flavor Prediction', description: 'Uses ML for...' },
 *   { name: 'React', description: 'A JavaScript library' },
 * ];
 * const results = fuzzySearch(technologies, 'AI prediction', {
 *   keys: ['name', 'description'],
 * });
 * ```
 */
export function fuzzySearch<T extends object>(
  items: T[],
  query: string,
  options: FuzzySearchOptions<T> = {}
): T[] {
  const threshold = options.threshold ?? 0.2;
  const limit = options.limit;
  const keys = options.keys || (Object.keys(items[0] || {}) as (keyof T)[]);

  const results = rankObjectResults(items, query, keys, threshold);

  // Apply limit
  const limited = limit ? results.slice(0, limit) : results;

  return limited.map(r => r.item);
}

/**
 * Perform fuzzy search with scores included in results
 *
 * @param items - Array of objects to search
 * @param query - Search query
 * @param options - Search options
 * @returns Matched items with scores, sorted by exact/prefix precedence, then score
 */
export function fuzzySearchWithScores<T extends object>(
  items: T[],
  query: string,
  options: FuzzySearchOptions<T> = {}
): FuzzySearchResult<T>[] {
  const threshold = options.threshold ?? 0.2;
  const limit = options.limit;
  const keys = options.keys || (Object.keys(items[0] || {}) as (keyof T)[]);

  const results = rankObjectResults(items, query, keys, threshold);

  // Apply limit
  const limited = limit ? results.slice(0, limit) : results;
  return limited.map(({ item, score, matchedTerms }) => ({ item, score, matchedTerms }));
}

/**
 * Quick check if a query matches text (without scoring)
 * More performant when you just need yes/no
 */
export function fuzzyMatches(query: string, text: string, threshold = 0.2): boolean {
  const { score } = calculateMatchScore(query, text);
  return score >= threshold;
}
