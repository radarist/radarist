'use client';

/**
 * @file DocumentUploadButton/UrlImportTab.tsx
 * @description URL import tab content with validation, submission, and error display
 */

import React, { useState, useCallback } from 'react';
import { Globe, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { documentKeys } from '@/lib/query-keys';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';
import type { UploadedDocument } from './types';

const log = createLogger('ui/DocumentUploadButton/UrlImport');

interface UrlImportTabProps {
  onUploadComplete?: (document: UploadedDocument) => void;
  onCloseDialog: () => void;
}

/**
 * Validate a URL string. Returns an error message or null if valid.
 */
function validateUrl(url: string): string | null {
  if (!url.trim()) {
    return 'Please enter a URL';
  }

  let normalizedUrl = url.trim();
  if (!normalizedUrl.match(/^https?:\/\//i)) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  try {
    const parsed = new URL(normalizedUrl);

    const dangerousSchemes = ['javascript:', 'data:', 'file:', 'vbscript:'];
    if (dangerousSchemes.some((s) => parsed.protocol.toLowerCase() === s)) {
      return 'This URL scheme is not allowed';
    }

    if (!['http:', 'https:'].includes(parsed.protocol.toLowerCase())) {
      return 'Only HTTP and HTTPS URLs are supported';
    }

    return null;
  } catch {
    return 'Please enter a valid URL';
  }
}

export function UrlImportTab({ onUploadComplete, onCloseDialog }: UrlImportTabProps) {
  const queryClient = useQueryClient();
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = useCallback(async () => {
    const validationError = validateUrl(urlInput);
    if (validationError) {
      setUrlError(validationError);
      return;
    }

    setUrlError(null);
    setIsProcessing(true);

    try {
      let normalizedUrl = urlInput.trim();
      if (!normalizedUrl.match(/^https?:\/\//i)) {
        normalizedUrl = `https://${normalizedUrl}`;
      }

      const response = await fetchWithAuth('/api/documents/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: normalizedUrl }) });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 409) {
          setUrlError('A document with this URL already exists');
        } else {
          setUrlError(data.error || 'Failed to process URL');
        }
        return;
      }

      setSuccess(true);
      toast.success('URL added successfully', {
        description: 'The document is being processed. You can view it in your library.' });

      queryClient.invalidateQueries({ queryKey: documentKeys.all });

      onUploadComplete?.({
        id: data.document.id,
        title: data.document.title,
        type: data.document.type,
        status: data.document.status });

      setTimeout(() => {
        onCloseDialog();
      }, 1500);
    } catch (error) {
      log.error('Failed to process URL', error instanceof Error ? error : undefined);
      setUrlError('Failed to process URL. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  }, [urlInput, queryClient, onUploadComplete, onCloseDialog]);

  if (success) {
    return (
      <div className="py-8 flex flex-col items-center text-center">
        <CheckCircle2 className="h-12 w-12 text-green-500 mb-4" />
        <p className="text-lg font-medium">URL Added Successfully</p>
        <p className="text-sm text-muted-foreground mt-2">
          The document is being processed and will appear in your library shortly.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="url-input">Web Page URL</Label>
        <Input
          id="url-input"
          type="url"
          placeholder="https://example.com/article"
          value={urlInput}
          onChange={(e) => {
            setUrlInput(e.target.value);
            setUrlError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isProcessing) {
              handleSubmit();
            }
          }}
          disabled={isProcessing}
          className={cn(urlError && 'border-destructive')}
        />
        <p className="text-xs text-muted-foreground">
          Enter a URL to import content from a web page. The page content will be extracted and processed.
        </p>
      </div>

      {/* URL Error */}
      {urlError && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {urlError}
        </div>
      )}

      {/* Submit Button */}
      <Button onClick={handleSubmit} disabled={isProcessing || !urlInput.trim()} className="w-full">
        {isProcessing ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Processing...
          </>
        ) : (
          <>
            <Globe className="h-4 w-4 mr-2" />
            Import from URL
          </>
        )}
      </Button>
    </div>
  );
}
