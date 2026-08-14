/**
 * @file app/settings/page.tsx
 * @description Global application configuration page
 *
 * This page contains global system configuration:
 * - Data Management: Archive retention settings
 * - Notifications: Email and Slack integration
 *
 * The page uses a tabbed layout with additional sections:
 * - Agent Config: Visual editor for agent sweep/budget/model settings
 * - Agent Profiles: Read-only viewer for the 6 Impulse agent profiles
 * - MCP Servers: Connection status dashboard
 * - Token Budget: Usage visualization and budget controls
 *
 * Agent-related settings split:
 * - AI Assistant (display mode, panel width, notifications) — this page, "AI Assistant" tab
 * - Other agent tuning lives under /agents/* pages
 *
 * @author Radarist Team
 * @created 2025-11-26
 * @updated 2026-02-23 - Added Impulse config tabs
 */

'use client';

import { useState, useEffect, Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Bell,
  Bot,
  Archive,
  Database,
  Loader2,
  Save,
  RotateCcw,
  Settings2,
  Users,
  Server,
  Coins,
  Sparkles,
} from 'lucide-react';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { NotificationPanel } from '@/components/settings/NotificationPanel';
import { AgentConfigEditor } from '@/components/settings/AgentConfigEditor';
import { AgentProfilesViewer } from '@/components/settings/AgentProfilesViewer';
import { McpServersStatus } from '@/components/settings/McpServersStatus';
import { McpApiKeysPanel } from '@/components/settings/McpApiKeysPanel';
import { TokenBudgetDashboard } from '@/components/settings/TokenBudgetDashboard';
import { AIAssistantPanel } from '@/components/settings/AIAssistantPanel';
import { SettingsSkeleton } from '@/components/skeletons';
import { useUrlState } from '@/hooks/useUrlState';
import { getSystemConfig } from '@/lib/system-config';
import { getPlatformConfig, updatePlatformConfig, type PlatformConfig } from '@/lib/platform-config';
import {
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  MIN_ARCHIVE_RETENTION_DAYS,
  isValidArchiveRetentionDays,
} from '@/lib/platform-config-schema';
import type { SystemConfiguration } from '@/lib/types';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';

const log = createLogger('settings-page');

/** Tab ids accepted by the `?tab=` deep-link (e.g. /settings?tab=agent-config). */
const SETTINGS_TABS = ['general', 'ai-assistant', 'agent-config', 'profiles', 'mcp-servers', 'token-budget'] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const DEFAULT_TAB: SettingsTab = 'general';

function isSettingsTab(value: string | undefined): value is SettingsTab {
  return value !== undefined && (SETTINGS_TABS as readonly string[]).includes(value);
}

/**
 * General settings content — Data Management + Notifications + Agent Settings link.
 */
export function GeneralSettingsContent({
  config,
  archiveRetentionDays,
  setArchiveRetentionDays,
  hasChanges,
  isSaving,
  onSave,
  onReset,
  onConfigUpdate,
}: {
  config: SystemConfiguration;
  archiveRetentionDays: number;
  setArchiveRetentionDays: (value: number) => void;
  hasChanges: boolean;
  isSaving: boolean;
  onSave: () => void;
  onReset: () => void;
  onConfigUpdate: () => void;
}) {
  const isRetentionValid = isValidArchiveRetentionDays(archiveRetentionDays);

  return (
    <div className="space-y-8">
      {/* Data Management Settings */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Database className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Data Management</h2>
        </div>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Archive className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Archive Settings</CardTitle>
                <CardDescription>
                  Configure how long archived signals are retained before permanent deletion
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="max-w-sm">
              <div className="space-y-2">
                <Label htmlFor="archiveRetention">Archive Retention (days)</Label>
                <Input
                  id="archiveRetention"
                  type="number"
                  min={MIN_ARCHIVE_RETENTION_DAYS}
                  max={MAX_ARCHIVE_RETENTION_DAYS}
                  value={archiveRetentionDays}
                  onChange={(e) => setArchiveRetentionDays(Number(e.target.value))}
                  aria-invalid={!isRetentionValid}
                  aria-describedby="archiveRetentionHelp"
                />
                <p
                  id="archiveRetentionHelp"
                  className={`text-xs ${isRetentionValid ? 'text-muted-foreground' : 'text-destructive'}`}
                  role={isRetentionValid ? undefined : 'alert'}
                >
                  {isRetentionValid
                    ? 'Archived signals older than this are deleted weekly while the synced Inngest dev server is running; the job can also be invoked manually.'
                    : `Enter a whole number from ${MIN_ARCHIVE_RETENTION_DAYS} to ${MAX_ARCHIVE_RETENTION_DAYS} days.`}
                </p>
              </div>
            </div>

            {/* Save/Reset buttons */}
            <div
              className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between"
              role="group"
              aria-label="Archive settings actions"
            >
              <Button variant="outline" size="sm" onClick={onReset} disabled={!hasChanges}>
                <RotateCcw className="h-4 w-4 mr-2" />
                Reset to Defaults
              </Button>
              <Button size="sm" onClick={onSave} disabled={!hasChanges || isSaving || !isRetentionValid}>
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4 mr-2" />
                    Save Changes
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Notification Settings */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Bell className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Notifications</h2>
        </div>
        <NotificationPanel config={config} onUpdate={onConfigUpdate} />
      </div>
    </div>
  );
}

/**
 * Configuration Page Content
 *
 * Global application configuration hub with tabbed layout:
 * General, AI Assistant, Agent Config, Profiles, MCP Servers, Token Budget.
 * The active tab is deep-linkable via `?tab=` (read client-side through
 * useUrlState/useSearchParams — hence the Suspense wrapper in the default
 * export, matching the radar page convention).
 *
 * @component
 */
function ConfigurationPageContent() {
  // ?tab= deep-link — unknown values fall back to the default tab.
  const { value: tabParam, setValue: setTabParam } = useUrlState<string>('tab');
  const activeTab: SettingsTab = isSettingsTab(tabParam) ? tabParam : DEFAULT_TAB;

  const [config, setConfig] = useState<SystemConfiguration | null>(null);
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Local state for editable fields
  const [archiveRetentionDays, setArchiveRetentionDays] = useState(DEFAULT_ARCHIVE_RETENTION_DAYS);

  /**
   * Load configurations on component mount
   */
  useEffect(() => {
    loadConfig();
  }, []);

  /**
   * Fetches all configurations from Firestore
   */
  const loadConfig = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const [systemConfig, platform] = await Promise.all([getSystemConfig(), getPlatformConfig()]);
      setConfig(systemConfig);
      setPlatformConfig(platform);
      setArchiveRetentionDays(platform.archiveRetentionDays);
    } catch (err) {
      log.error('Error loading configuration', err instanceof Error ? err : new Error(String(err)));
      setError('Failed to load configuration. Please refresh the page.');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Callback to refresh configuration after updates
   */
  const handleConfigUpdate = async () => {
    await loadConfig();
  };

  /**
   * Save platform configuration changes
   */
  const handleSavePlatformConfig = async () => {
    if (!isValidArchiveRetentionDays(archiveRetentionDays)) {
      toast.error(
        `Archive retention must be a whole number from ${MIN_ARCHIVE_RETENTION_DAYS} to ${MAX_ARCHIVE_RETENTION_DAYS} days`
      );
      return;
    }

    try {
      setIsSaving(true);
      await updatePlatformConfig({
        archiveRetentionDays,
      });
      toast.success('Configuration saved');
      await loadConfig();
    } catch (err) {
      log.error('Error saving configuration', err instanceof Error ? err : new Error(String(err)));
      toast.error('Failed to save configuration');
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Reset to default values
   */
  const handleResetDefaults = () => {
    setArchiveRetentionDays(DEFAULT_ARCHIVE_RETENTION_DAYS);
  };

  const hasChanges = platformConfig ? archiveRetentionDays !== platformConfig.archiveRetentionDays : false;

  if (isLoading) {
    return (
      <SmartLayout>
        <div className="h-full flex flex-col">
          <div className="flex-1 overflow-auto p-6">
            <SettingsSkeleton />
          </div>
        </div>
      </SmartLayout>
    );
  }

  if (error || !config) {
    return (
      <SmartLayout>
        <div className="h-full flex flex-col">
          <div className="flex-1 overflow-auto p-6">
            <Card className="border-destructive max-w-xl mx-auto">
              <CardHeader>
                <CardTitle className="text-destructive">Configuration Error</CardTitle>
                <CardDescription>{error || 'Failed to load configuration'}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={loadConfig}>Retry</Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </SmartLayout>
    );
  }

  // Shared props for the general settings content
  const generalProps = {
    config,
    archiveRetentionDays,
    setArchiveRetentionDays,
    hasChanges,
    isSaving,
    onSave: handleSavePlatformConfig,
    onReset: handleResetDefaults,
    onConfigUpdate: handleConfigUpdate,
  };

  return (
    <SmartLayout>
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-5xl mx-auto space-y-6">
            <Tabs value={activeTab} onValueChange={setTabParam} className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="general" className="gap-1.5">
                  <Settings2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">General</span>
                </TabsTrigger>
                <TabsTrigger value="ai-assistant" className="gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">AI Assistant</span>
                </TabsTrigger>
                <TabsTrigger value="agent-config" className="gap-1.5">
                  <Bot className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Agent Config</span>
                </TabsTrigger>
                <TabsTrigger value="profiles" className="gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Profiles</span>
                </TabsTrigger>
                <TabsTrigger value="mcp-servers" className="gap-1.5">
                  <Server className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">MCP Servers</span>
                </TabsTrigger>
                <TabsTrigger value="token-budget" className="gap-1.5">
                  <Coins className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Token Budget</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="general">
                <GeneralSettingsContent {...generalProps} />
              </TabsContent>

              <TabsContent value="ai-assistant">
                <AIAssistantPanel />
              </TabsContent>

              <TabsContent value="agent-config">
                <AgentConfigEditor />
              </TabsContent>

              <TabsContent value="profiles">
                <AgentProfilesViewer />
              </TabsContent>

              <TabsContent value="mcp-servers" className="space-y-8">
                <McpServersStatus />
                <McpApiKeysPanel />
              </TabsContent>

              <TabsContent value="token-budget">
                <TokenBudgetDashboard />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </SmartLayout>
  );
}

/**
 * Configuration Page (default export)
 *
 * useSearchParams (via useUrlState) requires a Suspense boundary during
 * prerendering — same wrapper pattern as src/app/radar/page.tsx.
 */
export default function ConfigurationPage() {
  return (
    <Suspense
      fallback={
        <SmartLayout>
          <div className="h-full flex flex-col">
            <div className="flex-1 overflow-auto p-6">
              <SettingsSkeleton />
            </div>
          </div>
        </SmartLayout>
      }
    >
      <ConfigurationPageContent />
    </Suspense>
  );
}
