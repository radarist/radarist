/**
 * @file useArtifactsPage.ts
 * @description Drives the /artifacts OUTPUTS catalog (library-grade): build
 * missions that produced an output, derived into rows + search/kind filter +
 * sort + pagination. Reuses useBuildMissions (no new endpoint).
 */
'use client';

import { useMemo, useState } from 'react';
import { useBuildMissions } from '@/hooks/queries/useBuildMissions';
import { artifactKindOf, hasArtifactOutput, outputStatus } from '@/lib/artifact-output-ui';
import { missionTitle } from '@/lib/build-mission-ui';
import type { ArtifactKind } from '@/lib/schemas/mission-build';
import type { SortConfig } from '@/components/library/shared/types';
import type { Mission } from '@/lib/schemas/mission';

function sortValue(m: Mission, key: string): string {
  switch (key) {
    case 'kind':
      return artifactKindOf(m);
    case 'status':
      return outputStatus(m).label;
    case 'updated':
      return m.artifact?.publishedAt ?? m.completedAt ?? m.createdAt ?? '';
    case 'name':
    default:
      return missionTitle(m).toLowerCase();
  }
}

export function useArtifactsPage() {
  const { data: missions, isLoading, error, refetch } = useBuildMissions();
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<ArtifactKind | 'all'>('all');
  const [sortConfig, setSortConfig] = useState<SortConfig | null>({ key: 'updated', direction: 'desc' });
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  const filtered = useMemo(() => {
    const all = (missions ?? []).filter(hasArtifactOutput);
    const q = search.trim().toLowerCase();
    return all.filter((m) => {
      if (kindFilter !== 'all' && artifactKindOf(m) !== kindFilter) return false;
      if (q && !missionTitle(m).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [missions, search, kindFilter]);

  const sorted = useMemo(() => {
    if (!sortConfig) return filtered;
    const dir = sortConfig.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => sortValue(a, sortConfig.key).localeCompare(sortValue(b, sortConfig.key)) * dir);
  }, [filtered, sortConfig]);

  const paged = useMemo(
    () => sorted.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize),
    [sorted, pageIndex, pageSize]
  );

  const handleSort = (key: string) =>
    setSortConfig((prev) =>
      prev?.key === key ? (prev.direction === 'asc' ? { key, direction: 'desc' } : null) : { key, direction: 'asc' }
    );

  return {
    rows: paged,
    allFiltered: sorted,
    totalCount: sorted.length,
    isLoading,
    error,
    refetch,
    search,
    setSearch: (v: string) => {
      setSearch(v);
      setPageIndex(0);
    },
    kindFilter,
    setKindFilter: (v: ArtifactKind | 'all') => {
      setKindFilter(v);
      setPageIndex(0);
    },
    sortConfig,
    handleSort,
    pageIndex,
    pageSize,
    handlePageChange: setPageIndex,
    handlePageSizeChange: (n: number) => {
      setPageSize(n);
      setPageIndex(0);
    },
  };
}
