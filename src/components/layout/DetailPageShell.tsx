import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

interface DetailPageShellProps {
  /** Href for the back link, e.g. "/triage/signals" */
  backHref: string;
  /** Label for the back link, e.g. "Back to Signals" */
  backLabel: string;
  /** Page title, rendered as the h1 */
  title: string;
  /** Status pills row under the title */
  chips?: React.ReactNode;
  /** Top-right action buttons */
  actions?: React.ReactNode;
  /** Right rail (Details / scores) */
  aside: React.ReactNode;
  /** Main content cards */
  children: React.ReactNode;
}

/**
 * DetailPageShell
 *
 * The one shared layout template for entity detail pages (Signal, Assessment,
 * Insight, Run, …). Provides a consistent back link, title/chips/actions
 * header, and a two-column body (main content + right-rail aside).
 *
 * Pure layout — no client-side state — so it stays server-component-friendly
 * and callers opt into `"use client"` only where their own content needs it.
 */
export function DetailPageShell({ backHref, backLabel, title, chips, actions, aside, children }: DetailPageShellProps) {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-6">
      <Link
        href={backHref}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Link>

      <div className="mt-4 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-balance text-2xl font-bold tracking-tight">{title}</h1>
          {chips && (
            <div className="mt-2 flex flex-wrap gap-2" data-testid="detail-chips">
              {chips}
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-6">{children}</div>
        <aside className="min-w-0 space-y-6">{aside}</aside>
      </div>
    </div>
  );
}

export type { DetailPageShellProps };
