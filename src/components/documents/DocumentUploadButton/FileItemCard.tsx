'use client';

/**
 * @file DocumentUploadButton/FileItemCard.tsx
 * @description Individual file card with status display, metadata editing,
 *              and entity linking. Shown inside the file list.
 */

import React from 'react';
import { CheckCircle2, XCircle, X, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { FileUploadItem, EntitySelection } from './types';
import { getFileIcon } from './utils';
import { EntityLinkingSection } from './EntityLinkingSection';

interface FileItemCardProps {
  fileItem: FileUploadItem;
  isUploading: boolean;
  onRemove: (fileId: string) => void;
  onMetadataChange: (fileId: string, field: 'title' | 'description' | 'tags', value: string) => void;
  onEntitySelectionChange: (fileId: string, entityType: keyof EntitySelection, selectedIds: string[]) => void;
}

export function FileItemCard({
  fileItem,
  isUploading,
  onRemove,
  onMetadataChange,
  onEntitySelectionChange,
}: FileItemCardProps) {
  const FileIcon = getFileIcon(fileItem.file.name);

  return (
    <div
      className={cn(
        'border rounded-lg p-3 space-y-3 transition-colors',
        fileItem.status === 'success' && 'bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-800',
        fileItem.status === 'error' && 'bg-destructive/10 border-destructive/30'
      )}
    >
      {/* File Header */}
      <div className="flex items-center gap-3">
        <FileIcon
          className={cn('h-6 w-6 shrink-0', fileItem.status === 'success' ? 'text-green-600' : 'text-primary')}
        />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate" title={fileItem.file.name}>
            {fileItem.file.name}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {(fileItem.file.size / 1024).toFixed(1)} KB
            {fileItem.status === 'success' && ' \u2022 Uploaded'}
            {fileItem.status === 'uploading' && ' \u2022 Uploading...'}
            {fileItem.status === 'error' && ` \u2022 ${fileItem.error}`}
          </p>
        </div>
        {fileItem.status === 'success' && <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />}
        {fileItem.status === 'uploading' && <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />}
        {fileItem.status === 'error' && <XCircle className="h-5 w-5 text-destructive shrink-0" />}
        {fileItem.status === 'pending' && !isUploading && (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-8 w-8"
            onClick={() => onRemove(fileItem.id)}
            aria-label={`Remove ${fileItem.file.name} from upload list`}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Upload Progress */}
      {fileItem.status === 'uploading' && <Progress value={fileItem.progress} className="h-1" />}

      {/* Metadata Fields (only for pending files) */}
      {fileItem.status === 'pending' && !isUploading && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={fileItem.title}
              onChange={(e) => onMetadataChange(fileItem.id, 'title', e.target.value)}
              placeholder="Title"
              className="h-8 text-sm flex-1"
              title={fileItem.title}
            />
            {fileItem.aiGenerating && <Sparkles className="h-4 w-4 text-primary animate-pulse shrink-0" />}
          </div>
          <Input
            value={fileItem.description}
            onChange={(e) => onMetadataChange(fileItem.id, 'description', e.target.value)}
            placeholder="Description (optional)"
            className="h-8 text-sm"
            title={fileItem.description}
          />
          <Input
            value={fileItem.tags}
            onChange={(e) => onMetadataChange(fileItem.id, 'tags', e.target.value)}
            placeholder="Tags (comma-separated)"
            className="h-8 text-sm"
          />

          {/* Entity Linking */}
          <EntityLinkingSection
            entitySelection={fileItem.entitySelection}
            onSelectionChange={(entityType, ids) => onEntitySelectionChange(fileItem.id, entityType, ids)}
          />
        </div>
      )}
    </div>
  );
}
