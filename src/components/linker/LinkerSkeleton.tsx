/**
 * @file components/linker/LinkerSkeleton.tsx
 * @description Loading skeleton for the Linker Triage page
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ============================================================================
// PROPOSED RELATION CARD SKELETON
// ============================================================================

function ProposedRelationCardSkeleton() {
  return (
    <Card className="border-2">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 space-y-3">
            {/* Badges */}
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-20" />
            </div>
            {/* Confidence */}
            <div className="flex items-center gap-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-2 w-20 rounded-full" />
              <Skeleton className="h-4 w-10" />
            </div>
          </div>
          {/* Timestamp */}
          <Skeleton className="h-4 w-24" />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Entity relationship */}
        <div className="flex items-center gap-3">
          {/* Source entity */}
          <div className="flex-1 p-2 rounded-lg border">
            <Skeleton className="h-3 w-16 mb-1" />
            <Skeleton className="h-5 w-32" />
          </div>
          {/* Arrow and relation type */}
          <div className="flex flex-col items-center gap-1 shrink-0">
            <Skeleton className="h-5 w-5" />
            <Skeleton className="h-5 w-16" />
          </div>
          {/* Target entity */}
          <div className="flex-1 p-2 rounded-lg border">
            <Skeleton className="h-3 w-16 mb-1" />
            <Skeleton className="h-5 w-32" />
          </div>
        </div>

        {/* Reasoning */}
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3 pt-4 border-t">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// LINKER PAGE SKELETON
// ============================================================================

interface LinkerSkeletonProps {
  className?: string;
}

export function LinkerSkeleton({ className }: LinkerSkeletonProps) {
  return (
    <div className={cn("space-y-6", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-20 mt-2" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-32" />
      </div>

      {/* Content area */}
      <div className="max-w-2xl mx-auto space-y-4">
        {/* Progress card */}
        <Card>
          <CardContent className="py-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
            </div>
          </CardContent>
        </Card>

        {/* Keyboard shortcuts card */}
        <Card className="border-dashed">
          <CardContent className="py-3">
            <div className="flex items-center justify-center gap-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-6 w-20" />
            </div>
          </CardContent>
        </Card>

        {/* Proposal card */}
        <ProposedRelationCardSkeleton />

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// LIST SKELETON
// ============================================================================

export function LinkerListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Card key={i}>
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              {/* Checkbox */}
              <Skeleton className="h-4 w-4 rounded" />

              {/* Entity badges */}
              <div className="flex items-center gap-2 flex-1">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-8 w-32" />
              </div>

              {/* Confidence */}
              <Skeleton className="h-5 w-12" />

              {/* Actions */}
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-8" />
                <Skeleton className="h-8 w-8" />
                <Skeleton className="h-8 w-8" />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
