import { AddEntrySheet } from '@/components/AddEntrySheet';
import { SettingsDialog } from '@/components/SettingsDialog';
import { RadarManagementDialog } from '@/components/RadarManagementDialog';
import { ResearchDialog } from '@/components/ResearchDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type {
  RadarEntry,
  RadarEntrySaveInput,
  RadarManagementResult,
  QuadrantConfig,
  RingSystem,
  Company,
  UseCase,
} from '@/lib/types';

interface RadarDialogsProps {
  isSheetOpen: boolean;
  setIsSheetOpen: (isOpen: boolean) => void;
  /** Fired when the entry sheet closes WITHOUT a save — lets the page
   * abandon a pending signal import so its provenance can never attach to
   * a later unrelated save (adversarial #1). */
  onSheetDismissed?: () => void;
  entryToEdit: RadarEntry | null;
  setEntryToEdit: (entry: RadarEntry | null) => void;
  handleSaveEntry: (entry: RadarEntrySaveInput) => void | Promise<unknown>;
  quadrants: QuadrantConfig[];
  /** Existing entries on the radar (to check for duplicates) */
  entries?: RadarEntry[];

  isSettingsOpen: boolean;
  setIsSettingsOpen: (isOpen: boolean) => void;
  /**
   * Save radar quadrants + ring system. Returns a Promise so the dialog can
   * await the backend write (and keep itself open on failure). The third
   * argument is optional orphan-resolution options:
   *   - `reassignments: { [oldQuadrantId]: newQuadrantId }` — move orphaned
   *     placements to a surviving quadrant
   *   - `deleteOrphans: true` — delete any orphan not explicitly reassigned
   *
   * If the quadrant change would orphan placements and neither option is
   * provided, the service layer throws `OrphanedPlacementsError` — the
   * SettingsDialog catches it and opens the inline orphan-resolution UI.
   * Any other error surfaces as a toast.
   */
  handleSaveSettings: (
    quadrants: QuadrantConfig[],
    ringSystem: RingSystem,
    options?: { reassignments?: Record<string, string>; deleteOrphans?: boolean }
  ) => Promise<void> | void;
  ringSystem?: RingSystem;

  isRadarManagementOpen: boolean;
  setIsRadarManagementOpen: (isOpen: boolean) => void;
  radarManagementMode: 'create' | 'rename';
  selectedRadarName: string;
  radarId: string;
  handleCreateRadar: (name: string) => RadarManagementResult | Promise<RadarManagementResult>;
  handleRenameRadar: (name: string) => RadarManagementResult | Promise<RadarManagementResult>;

  entryToResearch: RadarEntry | null;
  isResearchOpen: boolean;
  setIsResearchOpen: (isOpen: boolean) => void;
  setEntryToResearch: (entry: RadarEntry | null) => void;
  handleDeleteEntry: (id: number) => void;
  handleEditEntry: (entry: RadarEntry) => void;
  handleSaveAnalysis: (id: number, analysis: string) => void;

  isDeleteConfirmOpen: boolean;
  setIsDeleteConfirmOpen: (isOpen: boolean) => void;
  /**
   * Server-confirmed deletion (LOCAL-010): resolves ok:false when the server
   * refused, in which case the hook already surfaced a retryable toast and
   * the radar stays listed. Fire-and-forget from the dialog action.
   */
  handleDeleteRadar: () => Promise<RadarManagementResult>;
  onCompanyClick?: (company: Company) => void;
  onUseCaseClick?: (useCase: UseCase) => void;
  onRefresh?: () => void;
}

import { RING_SYSTEMS } from '@/lib/constants';

/**
 * Component that groups all the dialogs and modals used in the Radar view.
 * This keeps the main `page.tsx` or `RadarView` cleaner by offloading modal state and rendering logic.
 *
 * Included dialogs:
 * - `AddEntrySheet`: For adding/editing radar entries.
 * - `ExploreTechnologiesDialog`: For discovering new technologies via AI.
 * - `SettingsDialog`: For configuring radar settings (quadrants, ring systems).
 * - `RadarManagementDialog`: For creating or renaming radars.
 * - `ResearchDialog`: For detailed view and AI analysis of an entry.
 * - `AlertDialog`: For confirming destructive actions like deleting a radar.
 *
 * @param props - Extensive list of props to control the visibility and callbacks for each dialog.
 * @returns The rendered fragment containing all dialogs.
 */
export function RadarDialogs({
  isSheetOpen,
  setIsSheetOpen,
  onSheetDismissed,
  entryToEdit,
  setEntryToEdit,
  handleSaveEntry,
  quadrants,
  entries,

  isSettingsOpen,
  setIsSettingsOpen,
  handleSaveSettings,
  ringSystem,

  isRadarManagementOpen,
  setIsRadarManagementOpen,
  radarManagementMode,
  selectedRadarName,
  radarId,
  handleCreateRadar,
  handleRenameRadar,

  entryToResearch,
  isResearchOpen,
  setIsResearchOpen,
  setEntryToResearch,
  handleDeleteEntry,
  handleEditEntry,
  handleSaveAnalysis,

  isDeleteConfirmOpen,
  setIsDeleteConfirmOpen,
  handleDeleteRadar,
  onCompanyClick,
  onUseCaseClick,
  onRefresh,
}: RadarDialogsProps) {
  const rings = (ringSystem ? RING_SYSTEMS[ringSystem] : RING_SYSTEMS['Standard']) as unknown as string[];

  return (
    <>
      <AddEntrySheet
        isOpen={isSheetOpen}
        onOpenChange={(isOpen) => {
          setIsSheetOpen(isOpen);
          if (!isOpen) {
            setEntryToEdit(null);
            onSheetDismissed?.();
          }
        }}
        onSaveEntry={handleSaveEntry}
        initialData={entryToEdit}
        quadrants={quadrants}
        rings={rings}
        existingEntries={entries}
      />
      <SettingsDialog
        isOpen={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        quadrants={quadrants}
        onSave={handleSaveSettings}
        ringSystem={ringSystem}
      />
      <RadarManagementDialog
        isOpen={isRadarManagementOpen}
        onOpenChange={setIsRadarManagementOpen}
        mode={radarManagementMode}
        currentName={selectedRadarName}
        onCreate={handleCreateRadar}
        onRename={handleRenameRadar}
      />
      {entryToResearch && (
        <ResearchDialog
          isOpen={isResearchOpen}
          onOpenChange={(isOpen) => {
            setIsResearchOpen(isOpen);
            if (!isOpen) setEntryToResearch(null);
          }}
          entry={entryToResearch}
          onDelete={handleDeleteEntry}
          onEdit={handleEditEntry}
          onSaveAnalysis={handleSaveAnalysis}
          rings={rings}
          radarId={radarId}
          onCompanyClick={onCompanyClick}
          onUseCaseClick={onUseCaseClick}
          onRefresh={onRefresh}
        />
      )}
      <AlertDialog open={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              <span className="font-bold"> {selectedRadarName} </span>
              radar and all of its entries.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteRadar}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
