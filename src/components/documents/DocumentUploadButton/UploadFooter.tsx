'use client';

/**
 * @file DocumentUploadButton/UploadFooter.tsx
 * @description Footer bar with upload status summary and action buttons
 */

import React from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UploadFooterProps {
  isUploading: boolean;
  pendingCount: number;
  successCount: number;
  errorCount: number;
  totalCount: number;
  completedCount: number;
  onUpload: () => void;
  onClose: () => void;
}

export function UploadFooter({
  isUploading,
  pendingCount,
  successCount,
  errorCount,
  totalCount,
  completedCount,
  onUpload,
  onClose,
}: UploadFooterProps) {
  return (
    <div className="flex items-center justify-between pt-4 border-t">
      <div className="text-sm text-muted-foreground">
        {isUploading ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Uploading {completedCount + 1} of {pendingCount}...
          </span>
        ) : successCount === totalCount ? (
          <span className="text-green-600 font-medium">All documents uploaded!</span>
        ) : (
          <span>
            {pendingCount} pending{errorCount > 0 && `, ${errorCount} failed`}
            {successCount > 0 && `, ${successCount} uploaded`}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onClose} disabled={isUploading}>
          {successCount === totalCount ? 'Close' : 'Cancel'}
        </Button>
        {pendingCount > 0 && (
          <Button onClick={onUpload} disabled={isUploading || pendingCount === 0}>
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Upload {pendingCount} file{pendingCount > 1 ? 's' : ''}
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
