'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { RadarManagementResult } from '@/lib/types';

interface RadarManagementDialogProps {
  /** Whether the dialog is open. */
  isOpen: boolean;
  /** Callback to update the open state. */
  onOpenChange: (isOpen: boolean) => void;
  /** The mode of the dialog: 'create' new radar or 'rename' existing. */
  mode: 'create' | 'rename';
  /** The current name of the radar (if renaming). */
  currentName?: string;
  /** Callback when a radar is created. */
  onCreate: (name: string) => RadarManagementResult | Promise<RadarManagementResult>;
  /** Callback when a radar is renamed. */
  onRename: (name: string) => RadarManagementResult | Promise<RadarManagementResult>;
}

/**
 * Dialog for creating or renaming a radar.
 *
 * @param props - Component props.
 * @returns The rendered dialog.
 */
export function RadarManagementDialog({
  isOpen,
  onOpenChange,
  mode,
  currentName = '',
  onCreate,
  onRename,
}: RadarManagementDialogProps) {
  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const previousOpenRef = useRef(false);
  const previousModeRef = useRef(mode);

  useEffect(() => {
    const justOpened = isOpen && !previousOpenRef.current;
    const changedModeWhileOpen = isOpen && previousModeRef.current !== mode;
    if (justOpened || changedModeWhileOpen) {
      setName(mode === 'rename' ? currentName : '');
      setSaveError(null);
    }
    previousOpenRef.current = isOpen;
    previousModeRef.current = mode;
  }, [isOpen, mode, currentName]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || savingRef.current) return;

    // State alone is not a sufficient lock: an Enter keydown and button click
    // can arrive before React commits the disabled state.
    savingRef.current = true;
    setIsSaving(true);
    setSaveError(null);

    try {
      const result = await (mode === 'create' ? onCreate(trimmedName) : onRename(trimmedName));
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      onOpenChange(false);
    } catch {
      const action = mode === 'create' ? 'create' : 'rename';
      setSaveError(`Could not ${action} the radar. Check your connection and try again.`);
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const title = mode === 'create' ? 'Create New Radar' : 'Rename Radar';
  const description =
    mode === 'create' ? 'Enter a name for your new radar.' : 'Enter a new name for the current radar.';
  const buttonText = mode === 'create' ? 'Create Radar' : 'Rename Radar';

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!savingRef.current) onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="py-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="radar-name">Name</Label>
            <Input
              id="radar-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (saveError) setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleSave();
                }
              }}
              disabled={isSaving}
              aria-invalid={Boolean(saveError)}
              aria-describedby={saveError ? 'radar-name-error' : undefined}
            />
            {saveError && (
              <p id="radar-name-error" role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => void handleSave()} disabled={!name.trim() || isSaving} aria-busy={isSaving}>
            {isSaving ? 'Saving...' : buttonText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
