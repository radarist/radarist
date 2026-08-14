'use client';

import { ImageOff, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

const MAX_MANUAL_RETRIES = 2;
const MAX_RENDER_DIMENSION = 32_768;

export type VisualizationMediaStatus = 'loading' | 'available' | 'unavailable';

interface VisualizationMediaProps {
  src?: string | null;
  alt: string;
  width?: number;
  height?: number;
  variant: 'thumbnail' | 'detail' | 'public';
  fit?: 'contain' | 'cover';
  retryable?: boolean;
  testId?: string;
}

function renderDimension(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined || value <= 0 || value > MAX_RENDER_DIMENSION) {
    return undefined;
  }
  return Math.round(value);
}

/**
 * Renders persisted visualization media without leaving a failed image element
 * in the UI. Failures are local to a single manual attempt; owner views can
 * retry twice, while list and public views remain passive and bounded.
 */
export function VisualizationMedia({
  src,
  alt,
  width,
  height,
  variant,
  fit = 'contain',
  retryable = false,
  testId,
}: VisualizationMediaProps) {
  const [attempt, setAttempt] = useState(0);
  const [failedAttempt, setFailedAttempt] = useState<string | null>(null);
  const [loadedAttempt, setLoadedAttempt] = useState<string | null>(null);
  const usableSrc = typeof src === 'string' && src.trim().length > 0 ? src : null;
  const attemptKey = `${usableSrc ?? 'missing'}:${attempt}`;
  const status: VisualizationMediaStatus =
    !usableSrc || failedAttempt === attemptKey
      ? 'unavailable'
      : loadedAttempt === attemptKey
        ? 'available'
        : 'loading';
  const imageWidth = renderDimension(width);
  const imageHeight = renderDimension(height);
  const canRetry = retryable && usableSrc !== null && attempt < MAX_MANUAL_RETRIES;
  const isThumbnail = variant === 'thumbnail';

  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden bg-muted/50',
        isThumbnail ? 'h-10 w-10 rounded' : 'min-h-[240px] w-full'
      )}
      data-media-container-status={status}
    >
      {status !== 'unavailable' && usableSrc ? (
        // Storage download URLs are persisted data and may expire or become
        // unreadable. onError removes the element instead of showing browser
        // broken-image chrome.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={attemptKey}
          src={usableSrc}
          alt={alt}
          width={imageWidth}
          height={imageHeight}
          data-testid={testId}
          data-media-status={status}
          onLoad={() => setLoadedAttempt(attemptKey)}
          onError={() => setFailedAttempt(attemptKey)}
          className={cn(
            isThumbnail ? 'h-10 w-10' : 'h-auto w-full',
            fit === 'cover' ? 'object-cover' : 'object-contain',
            status === 'loading' ? 'opacity-0' : 'opacity-100'
          )}
        />
      ) : (
        <div className="flex max-w-sm flex-col items-center justify-center gap-2 px-4 py-6 text-center">
          <div role="img" aria-label={`${alt}: media unavailable`} title="Media unavailable">
            <ImageOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className={cn('font-medium text-muted-foreground', isThumbnail ? 'sr-only' : 'text-sm')}>
            Media unavailable
          </p>
          {!isThumbnail && <p className="text-xs text-muted-foreground">The stored image could not be loaded.</p>}
          {canRetry && (
            <button
              type="button"
              onClick={() => setAttempt((current) => current + 1)}
              className="mt-1 inline-flex h-8 items-center gap-2 rounded border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Retry media"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
