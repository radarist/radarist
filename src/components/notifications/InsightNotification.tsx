'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useAgentEventStream } from '@/hooks/useAgentEventStream';

/**
 * InsightNotification
 *
 * Invisible component that subscribes to the SSE event stream and
 * shows a toast notification whenever a new `insight.created` event arrives.
 * Mount once at the layout level (e.g., dashboard).
 */
export function InsightNotification() {
  const { events } = useAgentEventStream();
  const lastNotifiedIdRef = useRef<string | null>(null);

  useEffect(() => {
    const latestInsight = events.findLast((e) => e.type === 'insight.created');
    if (!latestInsight) return;
    if (latestInsight.id === lastNotifiedIdRef.current) return;

    lastNotifiedIdRef.current = latestInsight.id;
    toast.info('New insight from agent', {
      description: (latestInsight.data as Record<string, string>)?.summary ?? 'An agent discovered something new.',
    });
  }, [events]);

  return null;
}
