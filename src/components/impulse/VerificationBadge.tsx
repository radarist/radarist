'use client';

import { useVerification } from '@/hooks/useVerification';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface VerificationBadgeProps {
  entityId: string;
}

const STATUS_CONFIG = {
  verified: {
    icon: CheckCircle2,
    label: 'Verified',
    className: 'text-green-600 border-green-300',
  },
  unverified: {
    icon: AlertTriangle,
    label: 'Unverified',
    className: 'text-yellow-600 border-yellow-300',
  },
  disputed: {
    icon: XCircle,
    label: 'Disputed',
    className: 'text-red-600 border-red-300',
  },
} as const;

export function VerificationBadge({ entityId }: VerificationBadgeProps) {
  const { data: verification, isLoading } = useVerification(entityId);

  if (isLoading || !verification) return null;

  const config = STATUS_CONFIG[verification.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.unverified;
  const Icon = config.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={`gap-1 ${config.className}`} data-testid={`verification-badge-${entityId}`}>
          <Icon className="h-3 w-3" />
          {config.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent data-testid="verification-tooltip">
        <p>Score: {verification.score}/100</p>
        <p>
          {verification.sourcesChecked} sources checked, {verification.sourcesConfirming} confirming
        </p>
        {verification.reasoning && <p className="text-xs mt-1">{verification.reasoning}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
