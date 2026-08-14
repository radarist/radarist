'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { useToast } from '@/hooks/use-toast';
import {
  buildVisualizationExportFilename,
  fetchVisualizationExport,
  getVisualizationExportFormat,
} from '@/lib/visualization-export';

interface InfographicDownloadButtonProps {
  visualizationId: string;
  mimeType: string;
  title: string;
}

export function InfographicDownloadButton({ visualizationId, mimeType, title }: InfographicDownloadButtonProps) {
  const { toast } = useToast();
  const [isDownloading, setIsDownloading] = useState(false);
  const format = getVisualizationExportFormat(mimeType);

  const handleDownload = async () => {
    const filename = buildVisualizationExportFilename(title, mimeType);
    if (!format || !filename) return;

    setIsDownloading(true);
    try {
      const blob = await fetchVisualizationExport(visualizationId, mimeType, fetchWithAuth);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      try {
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        // Safari may not consume the object URL synchronously with click().
        // Keep it alive briefly, then release it without retaining the Blob.
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Download failed',
        description: error instanceof Error ? error.message : 'The infographic could not be downloaded.',
      });
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="viz-download"
      disabled={!format || isDownloading}
      onClick={handleDownload}
    >
      {isDownloading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
      {format ? `Download ${format.label}` : 'Download unavailable'}
    </Button>
  );
}
