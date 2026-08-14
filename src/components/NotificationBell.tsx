'use client';

import * as React from 'react';
import { Bell, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useUnreadDigests, useMarkDigestRead, useMarkAllDigestsRead } from '@/hooks/useDigests';
import type { Digest } from '@/lib/digests';

/**
 * NotificationBell
 *
 * Shows unread daily digest count with popover dropdown.
 */
export function NotificationBell() {
  const { data, error } = useUnreadDigests();
  const markRead = useMarkDigestRead();
  const markAllRead = useMarkAllDigestsRead();
  const digests: Digest[] = data?.digests ?? [];
  // AUDIT-008: on a failed fetch the unread count is unknown — hide the badge
  // rather than showing 0-as-if-all-read, and say so in the popover.
  const unreadCount = error ? 0 : digests.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-9 w-9" data-testid="notification-bell">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge
              className="absolute -top-0.5 -right-0.5 h-4 min-w-4 p-0 flex items-center justify-center text-[10px]"
              data-testid="notification-count"
            >
              {unreadCount}
            </Badge>
          )}
          <span className="sr-only">Notifications</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end" data-testid="digest-dropdown">
        <div className="p-3 border-b flex items-center justify-between gap-2">
          <h4 className="font-medium text-sm">Notifications</h4>
          {digests.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              data-testid="digest-mark-all-read"
              disabled={markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              Mark all read
            </Button>
          )}
        </div>
        {error ? (
          <div className="py-8 text-center text-sm text-muted-foreground" data-testid="digest-error">
            <Bell className="mx-auto mb-2 h-8 w-8 opacity-50" />
            Couldn&apos;t load notifications
          </div>
        ) : digests.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Bell className="mx-auto mb-2 h-8 w-8 opacity-50" />
            No new notifications
          </div>
        ) : (
          <div className="max-h-[300px] overflow-y-auto">
            {digests.map((digest) => (
              <div
                key={digest.id}
                data-testid={`digest-item-${digest.id}`}
                className="flex items-start gap-3 p-3 border-b last:border-0 hover:bg-muted/50"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{digest.date}</p>
                  <p className="text-xs text-muted-foreground">
                    {digest.summary.signalsDiscovered} signals, {digest.summary.connectionsFound} connections,{' '}
                    {digest.summary.insightsGenerated} insights
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  data-testid={`digest-mark-read-${digest.id}`}
                  onClick={() => markRead.mutate(digest.id)}
                >
                  <Check className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
