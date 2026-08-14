'use client';

/**
 * @file DocumentUploadButton/DropZone.tsx
 * @description Drag-and-drop file upload area with supported file type badges
 */

import React, { useRef, useCallback } from 'react';
import { Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SUPPORTED_EXTENSIONS, MAX_FILE_SIZE, MAX_FILES } from './types';

interface DropZoneProps {
  /** Whether the user is currently dragging over the zone */
  isDragging: boolean;
  /** Set dragging state */
  onDragStateChange: (dragging: boolean) => void;
  /** Handle selected files */
  onFilesSelect: (files: FileList | File[]) => void;
  /** Number of currently added files */
  currentFileCount: number;
  /** Whether this is the compact "add more" variant */
  compact?: boolean;
}

export function DropZone({
  isDragging,
  onDragStateChange,
  onFilesSelect,
  currentFileCount,
  compact = false,
}: DropZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      onDragStateChange(true);
    },
    [onDragStateChange]
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      onDragStateChange(false);
    },
    [onDragStateChange]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      onDragStateChange(false);
      if (e.dataTransfer.files.length > 0) {
        onFilesSelect(e.dataTransfer.files);
      }
    },
    [onDragStateChange, onFilesSelect]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        onFilesSelect(e.target.files);
        // Reset input to allow selecting the same file again
        e.target.value = '';
      }
    },
    [onFilesSelect]
  );

  const availableSlots = MAX_FILES - currentFileCount;

  return (
    <div
      className={cn(
        'border-2 border-dashed rounded-lg transition-colors cursor-pointer',
        'hover:border-primary/50 hover:bg-muted/50',
        isDragging && 'border-primary bg-primary/5',
        compact ? 'p-4' : 'p-6'
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={SUPPORTED_EXTENSIONS.join(',')}
        multiple
        onChange={handleInputChange}
        className="hidden"
      />

      <div className="flex flex-col items-center text-center">
        <Upload className={cn('text-muted-foreground', compact ? 'h-8 w-8 mb-3' : 'h-12 w-12 mb-4')} />
        {compact ? (
          <>
            <p className="text-sm font-medium mb-1">Add more files</p>
            <p className="text-sm text-muted-foreground">
              or click to browse ({availableSlots} slot{availableSlots !== 1 ? 's' : ''} available)
            </p>
          </>
        ) : (
          <>
            <p className="text-lg font-medium mb-1">Drag & drop documents here</p>
            <p className="text-sm text-muted-foreground mb-3">or click to browse ({MAX_FILES} slots available)</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap justify-center">
              <Badge variant="outline">PDF</Badge>
              <Badge variant="outline">DOCX</Badge>
              <Badge variant="outline">PPTX</Badge>
              <Badge variant="outline">TXT</Badge>
              <Badge variant="outline">MD</Badge>
              <span>Max {MAX_FILE_SIZE / (1024 * 1024)}MB each</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
