/**
 * @file app/radar/page.tsx
 * @description Technology Radar - Visual representation of technology landscape
 *
 * Phase 4.1 Refactor: Aligned with shadcn design system patterns
 * - Uses PageShell + PageHeader (like Companies/Technologies pages)
 * - 2-column layout with sidebar (entries + tags) and main radar area
 * - Consolidated header actions
 * - Removed page-local theme toggle (uses global theme)
 *
 * The Radar is the key differentiator of this platform:
 * - Interactive radar visualization with quadrants and rings
 * - Drag-and-drop technology positioning
 * - Research panel for deep-dive analysis
 * - Integration with signals, companies, and use cases
 *
 * @author Radarist Team
 * @created 2025-11-28
 * @updated 2025-11-29 - Phase 4.1 refactor for shadcn alignment
 */

'use client';

import { useState, useMemo, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useRadarData } from '@/hooks/useRadarData';
import { RadarSkeleton } from '@/components/skeletons';
import { useRadarEntriesDecoupled } from '@/hooks/useRadarEntriesDecoupled';
import { useRadarSignalImport } from '@/hooks/useRadarSignalImport';
import { RadarSidebarPanel } from '@/components/radar-page/RadarSidebarPanel';
import { RadarVisualization } from '@/components/radar-page/RadarVisualization';
import { RadarDialogs } from '@/components/radar-page/RadarDialogs';
import { RadarPageHeader } from '@/components/radar-page/RadarPageHeader';
import { RadarZeroState } from '@/components/radar-page/RadarZeroState';
import type { RadarEntry } from '@/lib/types';
import { resolveQuadrantConfigs } from '@/lib/radar-quadrants';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell } from '@/components/layout/PageShell';
import { CompanyDialog } from '@/components/scouting/CompanyDialog';
import { UseCaseDialog } from '@/components/scouting/UseCaseDialog';
import type { Company, UseCase } from '@/lib/types';
import { ErrorBoundary, ErrorFallback } from '@/components/feedback/ErrorBoundary';
import { ShareDialog } from '@/components/ShareDialog';

// ============================================================================
// LOADING FALLBACK
// ============================================================================

function RadarLoadingFallback() {
  return (
    <SmartLayout>
      <PageShell>
        <RadarSkeleton className="h-[calc(100vh-200px)]" />
      </PageShell>
    </SmartLayout>
  );
}

// ============================================================================
// MAIN PAGE (with Suspense wrapper)
// ============================================================================

export default function RadarPage() {
  return (
    <Suspense fallback={<RadarLoadingFallback />}>
      <RadarPageContent />
    </Suspense>
  );
}

// ============================================================================
// PAGE CONTENT
// ============================================================================

function RadarPageContent() {
  const router = useRouter();

  // ============================================================================
  // DATA HOOKS — radar metadata + decoupled placements
  // ============================================================================

  const {
    radars,
    selectedRadarId,
    setSelectedRadarId,
    isLoading: isLoadingRadars,
    handleCreateRadar,
    handleRenameRadar,
    handleDeleteRadar,
    handleSaveSettings,
  } = useRadarData();

  const selectedRadar = useMemo(() => radars.find((r) => r.id === selectedRadarId) ?? null, [radars, selectedRadarId]);

  const quadrants = resolveQuadrantConfigs(selectedRadar);

  const decoupledEntriesHook = useRadarEntriesDecoupled({
    radarId: selectedRadarId,
  });

  const isLoading = decoupledEntriesHook.isLoading || isLoadingRadars;
  const entries = decoupledEntriesHook.entries;

  const {
    activeTags,
    hoveredEntryId,
    setHoveredEntryId,
    entryToEdit,
    setEntryToEdit,
    entryToResearch,
    setEntryToResearch,
    filteredEntries,
    allTags,
    handleSaveEntry: originalHandleSaveEntry,
    handleDeleteEntry,
    handleTagClick,
    handleClearTags,
    handleSaveAnalysis,
    handleSaveEntryPosition,
  } = decoupledEntriesHook;

  const _refresh = decoupledEntriesHook.refresh;

  // ============================================================================
  // SETTINGS SAVE + CACHE REFRESH
  // ============================================================================

  /**
   * Wrap `handleSaveSettings` so after the radar-config write commits we also
   * force-refresh the decoupled placements query cache. A shrink-with-orphan
   * save can briefly leave the page with the new quadrant configs but stale
   * placements, which makes `calculateRadarPositions` complain about unknown
   * quadrantIds and hides the affected blips.
   */
  const handleSaveSettingsWithRefresh = async (
    newQuadrants: Parameters<typeof handleSaveSettings>[0],
    newRingSystem: Parameters<typeof handleSaveSettings>[1],
    options?: Parameters<typeof handleSaveSettings>[2]
  ) => {
    await handleSaveSettings(newQuadrants, newRingSystem, options);
    decoupledEntriesHook.refresh();
  };

  // ============================================================================
  // UI STATE
  // ============================================================================

  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isResearchOpen, setIsResearchOpen] = useState(false);
  const [isRadarManagementOpen, setIsRadarManagementOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [radarManagementMode, setRadarManagementMode] = useState<'create' | 'rename'>('create');
  const [isShareOpen, setIsShareOpen] = useState(false);

  // Company Dialog State
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);
  const [isCompanyDialogOpen, setIsCompanyDialogOpen] = useState(false);

  // Use Case Dialog State
  const [selectedUseCase, setSelectedUseCase] = useState<UseCase | null>(null);
  const [isUseCaseDialogOpen, setIsUseCaseDialogOpen] = useState(false);

  // ============================================================================
  // SIGNAL IMPORT (?importSignal=<id> → radar entry) — extracted hook
  // ============================================================================

  const { handleSaveEntry, abandonSignalImport } = useRadarSignalImport({
    selectedRadarId,
    quadrants,
    saveEntry: originalHandleSaveEntry,
    setEntryToEdit,
    openEntrySheet: () => setIsSheetOpen(true),
  });

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const openRadarManagement = (mode: 'create' | 'rename' | 'delete') => {
    // Defer past the Radix DropdownMenu/Select teardown: opening a modal
    // Dialog in the same tick the triggering menu closes corrupts the shared
    // body pointer-events lock, leaving the page frozen after the dialog is
    // dismissed (reproduced via "…" menu → Create New Radar → Esc).
    setTimeout(() => {
      if (mode === 'delete') {
        setIsDeleteConfirmOpen(true);
      } else {
        setRadarManagementMode(mode);
        setIsRadarManagementOpen(true);
      }
    }, 0);
  };

  const handleCompanyClick = (company: Company) => {
    setSelectedCompany(company);
    setIsCompanyDialogOpen(true);
  };

  const handleUseCaseClick = (useCase: UseCase) => {
    setSelectedUseCase(useCase);
    setIsUseCaseDialogOpen(true);
  };

  const handleCompanySaved = () => {
    setIsCompanyDialogOpen(false);
    setSelectedCompany(null);
  };

  const handleCompanyDeleted = () => {
    setIsCompanyDialogOpen(false);
    setSelectedCompany(null);
  };

  const handleEntryClick = (entry: RadarEntry) => {
    setEntryToResearch(entry);
    setIsResearchOpen(true);
  };

  const handleEditEntry = (entry: RadarEntry) => {
    setEntryToEdit(entry);
    setIsResearchOpen(false);
    setIsSheetOpen(true);
  };

  const handleAddEntry = () => {
    setEntryToEdit(null);
    setIsSheetOpen(true);
  };

  // ============================================================================
  // LOADING STATE
  // ============================================================================

  if (isLoading) {
    return (
      <SmartLayout>
        <PageShell>
          <RadarSkeleton className="h-[calc(100vh-200px)]" />
        </PageShell>
      </SmartLayout>
    );
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <SmartLayout>
      <PageShell className="h-[calc(100vh-57px)] flex flex-col overflow-hidden">
        {/* ================================================================
            PAGE HEADER - Title + Actions (shadcn pattern)
            ================================================================ */}
        <RadarPageHeader
          radars={radars}
          selectedRadarId={selectedRadarId}
          onSelectRadar={setSelectedRadarId}
          onCreateRadar={() => openRadarManagement('create')}
          onRenameRadar={() => openRadarManagement('rename')}
          onDeleteRadar={() => openRadarManagement('delete')}
          onShareRadar={() => setIsShareOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onAddEntry={handleAddEntry}
        />

        {/* ================================================================
            MAIN CONTENT - 2-column layout, or the zero-radar empty state
            (LOCAL-010: an empty radars collection is a valid durable state)
            ================================================================ */}
        {radars.length === 0 ? (
          <RadarZeroState
            onCreateRadar={() => openRadarManagement('create')}
            onBrowseTechnologies={() => router.push('/library/technologies')}
          />
        ) : (
          <div className="flex-1 flex gap-4 lg:gap-5 min-h-0 overflow-hidden">
            {/* Left Sidebar: Entries + Tags (narrower to give more radar space) */}
            <RadarSidebarPanel
              filteredEntries={filteredEntries}
              quadrants={quadrants}
              hoveredEntryId={hoveredEntryId}
              setHoveredEntryId={setHoveredEntryId}
              handleEntryClick={handleEntryClick}
              allTags={allTags}
              activeTags={activeTags}
              handleTagClick={handleTagClick}
              handleClearTags={handleClearTags}
              className="hidden lg:flex w-[280px] xl:w-[300px] shrink-0"
            />

            {/* Main Radar Area */}
            <ErrorBoundary
              fallbackRender={({ error, reset }) => (
                <ErrorFallback
                  error={error}
                  reset={reset}
                  title="Failed to render Radar"
                  description="There was a problem displaying the technology radar. Please try again."
                  className="flex-1"
                />
              )}
            >
              <RadarVisualization
                selectedRadar={selectedRadar}
                filteredEntries={filteredEntries}
                quadrants={quadrants}
                hoveredEntryId={hoveredEntryId}
                setHoveredEntryId={setHoveredEntryId}
                handleEntryClick={handleEntryClick}
                allTags={allTags}
                activeTags={activeTags}
                handleTagClick={handleTagClick}
                handleClearTags={handleClearTags}
                onRingSystemChange={(system) => handleSaveSettingsWithRefresh(quadrants, system)}
                onEntryDragEnd={(id, pos) => handleSaveEntryPosition(id, pos.x, pos.y)}
                className="flex-1"
              />
            </ErrorBoundary>
          </div>
        )}
      </PageShell>

      {/* ================================================================
          DIALOGS
          ================================================================ */}
      <RadarDialogs
        isSheetOpen={isSheetOpen}
        setIsSheetOpen={setIsSheetOpen}
        onSheetDismissed={abandonSignalImport}
        entryToEdit={entryToEdit}
        setEntryToEdit={setEntryToEdit}
        handleSaveEntry={handleSaveEntry}
        quadrants={quadrants}
        entries={entries}
        isSettingsOpen={isSettingsOpen}
        setIsSettingsOpen={setIsSettingsOpen}
        handleSaveSettings={handleSaveSettingsWithRefresh}
        ringSystem={selectedRadar?.ringSystem}
        isRadarManagementOpen={isRadarManagementOpen}
        setIsRadarManagementOpen={setIsRadarManagementOpen}
        radarManagementMode={radarManagementMode}
        selectedRadarName={selectedRadar?.name || ''}
        radarId={selectedRadar?.id || ''}
        handleCreateRadar={handleCreateRadar}
        handleRenameRadar={handleRenameRadar}
        entryToResearch={entryToResearch}
        isResearchOpen={isResearchOpen}
        setIsResearchOpen={setIsResearchOpen}
        setEntryToResearch={setEntryToResearch}
        handleDeleteEntry={handleDeleteEntry}
        handleEditEntry={handleEditEntry}
        handleSaveAnalysis={handleSaveAnalysis}
        isDeleteConfirmOpen={isDeleteConfirmOpen}
        setIsDeleteConfirmOpen={setIsDeleteConfirmOpen}
        handleDeleteRadar={handleDeleteRadar}
        onCompanyClick={handleCompanyClick}
        onUseCaseClick={handleUseCaseClick}
        onRefresh={_refresh}
      />

      {/* Share Dialog */}
      {selectedRadarId && <ShareDialog radarId={selectedRadarId} open={isShareOpen} onOpenChange={setIsShareOpen} />}

      {/* Company Dialog */}
      <CompanyDialog
        isOpen={isCompanyDialogOpen}
        onOpenChange={setIsCompanyDialogOpen}
        company={selectedCompany}
        isNew={false}
        onSaved={handleCompanySaved}
        onDeleted={handleCompanyDeleted}
      />

      {/* Use Case Dialog */}
      <UseCaseDialog
        isOpen={isUseCaseDialogOpen}
        onOpenChange={setIsUseCaseDialogOpen}
        useCase={selectedUseCase}
        readOnly={false}
      />

      {/* Note: Innovation Agent Chat removed - using global AI Assistant instead */}
    </SmartLayout>
  );
}
