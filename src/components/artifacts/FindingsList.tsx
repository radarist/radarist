/**
 * @file FindingsList.tsx
 * @description Shared renderer for artifact findings/metrics (kind badge + title
 * + optional metric + optional confidence). Reused by the Assessment triage card
 * and the /artifacts evaluation detail. Lifted from the old BuildMissionCard.
 */
'use client';

import { Badge } from '@/components/ui/badge';

export interface Finding {
  title: string;
  detail?: string;
  kind: string; // 'verdict' | 'benchmark' | 'risk' | 'observation'
  metric?: string;
  confidence?: number;
}

const KIND_VARIANT: Record<string, 'secondary' | 'destructive'> = { risk: 'destructive' };

export function FindingsList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {findings.map((f, i) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <Badge variant={KIND_VARIANT[f.kind] ?? 'secondary'} className="mt-0.5 shrink-0 text-[10px]">
            {f.kind}
          </Badge>
          <span className="flex-1">
            <span className="font-medium">{f.title}</span>
            {f.metric ? <span className="text-muted-foreground"> · {f.metric}</span> : null}
            {typeof f.confidence === 'number' ? (
              <span className="text-muted-foreground"> ({f.confidence}%)</span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
