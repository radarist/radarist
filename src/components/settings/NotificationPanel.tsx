'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Bell, Mail, MessageSquare, Info } from 'lucide-react';
import type { SystemConfiguration } from '@/lib/types';

interface NotificationPanelProps {
  /** Current system configuration */
  config: SystemConfiguration;
  /** Callback when configuration is updated (unused while all channels are read-only) */
  onUpdate?: () => void;
}

/**
 * Notification Configuration Panel
 *
 * Shows the notification channels the platform supports. In the current
 * prototype every configurable channel is read-only:
 * - **Dashboard**: In-app notifications (always enabled)
 * - **Email**: Email alerts (coming soon — toggle disabled)
 * - **Slack**: Slack webhook integration (not available — input disabled)
 *
 * There is intentionally no Save button: with all controls disabled there is
 * nothing to save. When email/Slack ship, restore the save flow via
 * `updateNotificationConfig` from `@/lib/system-config`.
 *
 * **Notification Triggers:**
 * - High-priority signals detected
 * - Agent activities requiring review
 * - Automatic actions performed in Autopilot mode
 * - System alerts and configuration changes
 *
 * @component
 */
export function NotificationPanel({ config }: NotificationPanelProps) {
  const notifConfig = config.notifications;

  /**
   * Counts how many notification channels are enabled
   */
  const getEnabledChannelCount = () => {
    let count = 1; // Dashboard always enabled
    if (notifConfig.email) count++;
    if (notifConfig.slack) count++;
    return count;
  };

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-5 w-5 text-primary" />
                Notification Preferences
              </CardTitle>
              <CardDescription className="mt-1">
                Choose how and when you want to be notified about platform activity
              </CardDescription>
            </div>
            <Badge variant="outline">
              {getEnabledChannelCount()} {getEnabledChannelCount() === 1 ? 'channel' : 'channels'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              Notifications help you stay informed about high-priority signals, agent activities, and actions requiring
              your attention.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Notification Channels Card */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Channels</CardTitle>
          <CardDescription>Select which channels to use for receiving notifications</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Dashboard Notifications (Always On) */}
          <div className="flex items-start justify-between space-x-4 rounded-lg border p-4 bg-muted/50">
            <div className="flex items-start gap-3 flex-1">
              <div className="mt-1 text-primary">
                <Bell className="h-4 w-4" />
              </div>
              <div className="flex-1 space-y-1">
                <Label className="font-medium">Dashboard Notifications</Label>
                <p className="text-sm text-muted-foreground">
                  In-app notifications displayed in the Dashboard. Always enabled for critical alerts.
                </p>
              </div>
            </div>
            <Badge variant="default" className="mt-1">
              Always On
            </Badge>
          </div>

          {/* Email Notifications (Future Feature) */}
          <div className="flex items-start justify-between space-x-4 rounded-lg border p-4 opacity-60">
            <div className="flex items-start gap-3 flex-1">
              <div className="mt-1 text-blue-500">
                <Mail className="h-4 w-4" />
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <Label htmlFor="email-notif" className="font-medium">
                    Email Notifications
                  </Label>
                  <Badge variant="secondary" className="text-xs">
                    Coming Soon
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Receive email alerts for high-priority signals and agent activities requiring review
                </p>
              </div>
            </div>
            <Switch
              id="email-notif"
              checked={notifConfig.email}
              disabled
              aria-label="Email notifications"
            />
          </div>
        </CardContent>
      </Card>

      {/* Slack Integration Card (Not Yet Available) */}
      <Card className="opacity-50 pointer-events-none">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-purple-500" />
                  Slack Integration
                </CardTitle>
                <Badge variant="outline" className="text-xs">
                  Not Available
                </Badge>
              </div>
              <CardDescription className="mt-1">Send notifications to a Slack channel via webhook</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="slack-webhook" className="font-semibold">
              Slack Webhook URL
            </Label>
            <p className="text-sm text-muted-foreground mb-2">
              Create a webhook in your Slack workspace and paste the URL here. Notifications will be posted to the
              configured channel.
            </p>
            <Input
              id="slack-webhook"
              type="url"
              placeholder="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
              value={notifConfig.slack || ''}
              disabled
            />
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>How to set up Slack notifications:</strong>
              <ol className="mt-2 ml-4 space-y-1 text-sm list-decimal">
                <li>Go to your Slack workspace settings</li>
                <li>Create a new "Incoming Webhook" integration</li>
                <li>Select the channel where notifications should be posted</li>
                <li>Copy the webhook URL and paste it above</li>
              </ol>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Notification Types Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>What You'll Be Notified About</CardTitle>
          <CardDescription>Types of events that trigger notifications</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="mt-1 h-2 w-2 rounded-full bg-red-500" />
              <div>
                <p className="text-sm font-medium">High-Priority Signals</p>
                <p className="text-sm text-muted-foreground">When signals with high relevance scores are detected</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-1 h-2 w-2 rounded-full bg-orange-500" />
              <div>
                <p className="text-sm font-medium">Review Required</p>
                <p className="text-sm text-muted-foreground">When agent activities need human approval</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-1 h-2 w-2 rounded-full bg-blue-500" />
              <div>
                <p className="text-sm font-medium">Automated Actions</p>
                <p className="text-sm text-muted-foreground">When agents perform automated actions in Autopilot mode</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-1 h-2 w-2 rounded-full bg-purple-500" />
              <div>
                <p className="text-sm font-medium">System Alerts</p>
                <p className="text-sm text-muted-foreground">Important system events and configuration changes</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
