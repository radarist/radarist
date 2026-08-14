/**
 * @file app/api/search/route.ts
 * @description API route for searching entities across the platform
 *
 * Provides a unified search endpoint for finding every entity type in the
 * RelationPicker's default filter. Used by the RelationPicker and other
 * components that need to search for entities.
 *
 * PERFORMANCE OPTIMIZATION:
 * - Only fetches entity types that match the filter (if provided)
 * - Uses Promise.all for parallel fetching when searching multiple types
 * - Reads only one collection when a type filter is provided
 *
 * @author Radarist Team
 * @created 2025-12-02
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { adminGetTechnologies } from '@/lib/technology-admin';

const log = createLogger('api/search');
import { adminGetCompanies } from '@/lib/companies-admin';
import { adminGetUseCases } from '@/lib/use-cases-admin';
import { adminGetPrototypes } from '@/lib/prototypes-admin';
import { adminGetStrategies } from '@/lib/strategies-admin';
import { adminGetSignals } from '@/lib/signals-admin';
import { adminGetOrgUnits } from '@/lib/org-units-admin';
import { adminGetInitiatives } from '@/lib/initiatives-admin';
import { adminGetPainPoints } from '@/lib/pain-points-admin';
import type {
  Company,
  UseCase,
  Prototype,
  Strategy,
  Signal,
  OrgUnit,
  Initiative,
  PainPoint,
  Technology,
  EntityType,
} from '@/lib/types';

interface SearchResult {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
}

/**
 * Search technologies and return matching results.
 *
 * UX-030: reads the `technologies` collection DIRECTLY (via
 * `adminGetTechnologies`), not via the radar-placements join. The placements
 * join could only surface Technologies that had at least one placement, so a
 * standalone Technology was invisible in relation search, and the only
 * deduplication that existed was multi-radar. Reading the canonical collection
 * returns the full library; each Technology doc has a single stable `id`, so a
 * Technology placed on multiple radars is returned exactly once.
 *
 * Mirrors `searchCompanies` (fetch all, filter in-memory by name/description,
 * slice to limit). Logs and RE-THROWS on failure so the caller can record a
 * partial failure instead of letting a Firestore error masquerade as zero
 * results.
 */
async function searchTechnologies(searchLower: string, limit: number): Promise<SearchResult[]> {
  try {
    const technologies = await adminGetTechnologies();
    return technologies
      .filter(
        (t: Technology) => t.name.toLowerCase().includes(searchLower) || t.description?.toLowerCase().includes(searchLower)
      )
      .slice(0, limit)
      .map((t: Technology) => ({
        id: t.id,
        name: t.name,
        type: 'technology' as EntityType,
        description: t.description,
      }));
  } catch (error) {
    log.error('Error searching technologies', error instanceof Error ? error : undefined);
    throw error;
  }
}

/**
 * Search companies and return matching results.
 *
 * Logs and RE-THROWS on failure so the caller can record a partial failure
 * instead of letting a Firestore error masquerade as zero results.
 */
async function searchCompanies(searchLower: string, limit: number): Promise<SearchResult[]> {
  try {
    const companies = await adminGetCompanies();
    return companies
      .filter(
        (c: Company) => c.name.toLowerCase().includes(searchLower) || c.description?.toLowerCase().includes(searchLower)
      )
      .slice(0, limit)
      .map((c: Company) => ({
        id: c.id,
        name: c.name,
        type: 'company' as EntityType,
        description: c.description,
      }));
  } catch (error) {
    log.error('Error searching companies', error instanceof Error ? error : undefined);
    throw error;
  }
}

/**
 * Search use cases and return matching results.
 *
 * Logs and RE-THROWS on failure so the caller can record a partial failure
 * instead of letting a Firestore error masquerade as zero results.
 */
async function searchUseCases(searchLower: string, limit: number): Promise<SearchResult[]> {
  try {
    const useCases = await adminGetUseCases();
    return useCases
      .filter(
        (u: UseCase) =>
          u.title?.toLowerCase().includes(searchLower) || u.description?.toLowerCase().includes(searchLower)
      )
      .slice(0, limit)
      .map((u: UseCase) => ({
        id: u.id,
        name: u.title || 'Untitled Use Case',
        type: 'useCase' as EntityType,
        description: u.description,
      }));
  } catch (error) {
    log.error('Error searching use cases', error instanceof Error ? error : undefined);
    throw error;
  }
}

/**
 * Search prototypes and return matching results.
 *
 * Logs and RE-THROWS on failure so the caller can record a partial failure
 * instead of letting a Firestore error masquerade as zero results.
 */
async function searchPrototypes(searchLower: string, limit: number): Promise<SearchResult[]> {
  try {
    const prototypes = await adminGetPrototypes();
    return prototypes
      .filter(
        (p: Prototype) =>
          p.name.toLowerCase().includes(searchLower) || p.description?.toLowerCase().includes(searchLower)
      )
      .slice(0, limit)
      .map((p: Prototype) => ({
        id: p.id,
        name: p.name,
        type: 'prototype' as EntityType,
        description: p.description,
      }));
  } catch (error) {
    log.error('Error searching prototypes', error instanceof Error ? error : undefined);
    throw error;
  }
}

/**
 * Search strategies and return matching results.
 *
 * Logs and RE-THROWS on failure so the caller can record a partial failure
 * instead of letting a Firestore error masquerade as zero results.
 */
async function searchStrategies(searchLower: string, limit: number): Promise<SearchResult[]> {
  try {
    const strategies = await adminGetStrategies();
    return strategies
      .filter(
        (s: Strategy) =>
          s.name.toLowerCase().includes(searchLower) || s.description?.toLowerCase().includes(searchLower)
      )
      .slice(0, limit)
      .map((s: Strategy) => ({
        id: s.id,
        name: s.name,
        type: 'strategy' as EntityType,
        description: s.description,
      }));
  } catch (error) {
    log.error('Error searching strategies', error instanceof Error ? error : undefined);
    throw error;
  }
}

/**
 * Search signals and return matching results.
 *
 * Logs and RE-THROWS on failure so the caller can record a partial failure
 * instead of letting a Firestore error masquerade as zero results.
 */
async function searchSignals(searchLower: string, limit: number): Promise<SearchResult[]> {
  try {
    const signals = await adminGetSignals();
    return signals
      .filter(
        (s: Signal) => s.title.toLowerCase().includes(searchLower) || s.description?.toLowerCase().includes(searchLower)
      )
      .slice(0, limit)
      .map((s: Signal) => ({
        id: s.id,
        name: s.title,
        type: 'signal' as EntityType,
        description: s.description,
      }));
  } catch (error) {
    log.error('Error searching signals', error instanceof Error ? error : undefined);
    throw error;
  }
}

/** Search organizational units by name or description. */
async function searchOrgUnits(searchLower: string, limit: number): Promise<SearchResult[]> {
  try {
    const orgUnits = await adminGetOrgUnits();
    return orgUnits
      .filter(
        (orgUnit: OrgUnit) =>
          orgUnit.name.toLowerCase().includes(searchLower) ||
          orgUnit.description?.toLowerCase().includes(searchLower)
      )
      .slice(0, limit)
      .map((orgUnit: OrgUnit) => ({
        id: orgUnit.id,
        name: orgUnit.name,
        type: 'orgUnit' as EntityType,
        description: orgUnit.description,
      }));
  } catch (error) {
    log.error('Error searching org units', error instanceof Error ? error : undefined);
    throw error;
  }
}

/** Search initiatives by name or description. */
async function searchInitiatives(searchLower: string, limit: number): Promise<SearchResult[]> {
  try {
    const initiatives = await adminGetInitiatives();
    return initiatives
      .filter(
        (initiative: Initiative) =>
          initiative.name.toLowerCase().includes(searchLower) ||
          initiative.description?.toLowerCase().includes(searchLower)
      )
      .slice(0, limit)
      .map((initiative: Initiative) => ({
        id: initiative.id,
        name: initiative.name,
        type: 'initiative' as EntityType,
        description: initiative.description,
      }));
  } catch (error) {
    log.error('Error searching initiatives', error instanceof Error ? error : undefined);
    throw error;
  }
}

/** Search pain points by title or description. */
async function searchPainPoints(searchLower: string, limit: number): Promise<SearchResult[]> {
  try {
    const painPoints = await adminGetPainPoints();
    return painPoints
      .filter(
        (painPoint: PainPoint) =>
          painPoint.title.toLowerCase().includes(searchLower) ||
          painPoint.description?.toLowerCase().includes(searchLower)
      )
      .slice(0, limit)
      .map((painPoint: PainPoint) => ({
        id: painPoint.id,
        name: painPoint.title,
        type: 'painPoint' as EntityType,
        description: painPoint.description,
      }));
  } catch (error) {
    log.error('Error searching pain points', error instanceof Error ? error : undefined);
    throw error;
  }
}

/**
 * GET /api/search
 *
 * Search for entities by query string
 *
 * Query parameters:
 * - q: Search query (required)
 * - type: Entity type to filter by (optional: technology, company, useCase,
 *   prototype, strategy, signal, orgUnit, initiative, painPoint)
 * - limit: Maximum number of results per type (default: 10, max: 50)
 *
 * Examples:
 * - /api/search?q=react - Search all entity types for "react"
 * - /api/search?q=google&type=company - Search only companies for "google"
 * - /api/search?q=ai&limit=5 - Search all types, max 5 per type
 */
export async function GET(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);

    const query = searchParams.get('q');
    const entityType = searchParams.get('type') as EntityType | null;
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 50);

    if (!query || query.trim().length === 0) {
      return NextResponse.json({ success: false, error: 'Query parameter "q" is required' }, { status: 400 });
    }

    const searchLower = query.toLowerCase().trim();

    // OPTIMIZATION: Build array of search tasks ONLY for requested types.
    // This limits a filtered search to one Firestore collection.
    // Each task is tagged with its entity type so a per-type failure can be
    // attributed precisely (and reported) rather than silently dropped.
    const searchTasks: { type: EntityType; run: () => Promise<SearchResult[]> }[] = [];

    if (!entityType || entityType === 'technology') {
      searchTasks.push({ type: 'technology', run: () => searchTechnologies(searchLower, limit) });
    }
    if (!entityType || entityType === 'company') {
      searchTasks.push({ type: 'company', run: () => searchCompanies(searchLower, limit) });
    }
    if (!entityType || entityType === 'useCase') {
      searchTasks.push({ type: 'useCase', run: () => searchUseCases(searchLower, limit) });
    }
    if (!entityType || entityType === 'prototype') {
      searchTasks.push({ type: 'prototype', run: () => searchPrototypes(searchLower, limit) });
    }
    if (!entityType || entityType === 'strategy') {
      searchTasks.push({ type: 'strategy', run: () => searchStrategies(searchLower, limit) });
    }
    if (!entityType || entityType === 'signal') {
      searchTasks.push({ type: 'signal', run: () => searchSignals(searchLower, limit) });
    }
    if (!entityType || entityType === 'orgUnit') {
      searchTasks.push({ type: 'orgUnit', run: () => searchOrgUnits(searchLower, limit) });
    }
    if (!entityType || entityType === 'initiative') {
      searchTasks.push({ type: 'initiative', run: () => searchInitiatives(searchLower, limit) });
    }
    if (!entityType || entityType === 'painPoint') {
      searchTasks.push({ type: 'painPoint', run: () => searchPainPoints(searchLower, limit) });
    }

    // Execute all searches in PARALLEL (not sequential). Use allSettled so one
    // failing read does not reject the whole batch — but, unlike the previous
    // swallow-and-return-[] behavior, a failure is recorded against its type so
    // an error can NEVER masquerade as zero results.
    const settled = await Promise.allSettled(searchTasks.map((task) => task.run()));

    const results: SearchResult[] = [];
    const failedTypes: EntityType[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
      } else {
        failedTypes.push(searchTasks[index].type);
      }
    });

    // Every requested search failed → surface a hard error (non-200) instead of
    // a deceptively-successful empty result set.
    if (failedTypes.length > 0 && failedTypes.length === searchTasks.length) {
      log.error('All entity searches failed', undefined, { failedTypes, query });
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to search entities',
          failedTypes,
          query,
          type: entityType || 'all',
        },
        { status: 500 }
      );
    }

    // Some (but not all) searches failed → still return the partial results, but
    // flag the partial failure so callers don't read the gap as "no matches".
    if (failedTypes.length > 0) {
      log.warn('Partial entity search failure', { failedTypes, query });
      return NextResponse.json({
        success: true,
        partialFailure: true,
        failedTypes,
        data: results,
        count: results.length,
        query,
        type: entityType || 'all',
      });
    }

    return NextResponse.json({
      success: true,
      data: results,
      count: results.length,
      query,
      type: entityType || 'all',
    });
  } catch (error) {
    log.error('Search failed', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to search entities',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
