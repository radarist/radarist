/**
 * @file AIAssistantPanel.tsx
 * @description Settings panel for AI Assistant configuration
 *
 * Allows users to configure:
 * - Display mode (floating button vs persistent panel)
 * - Panel width (for panel mode)
 * - Keyboard shortcut
 * - Notification preferences
 *
 * @author Radarist Team
 * @created 2025-11-29
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Kbd } from '@/components/ui/kbd';
import { Sparkles, PanelRight, MessageCircle, GraduationCap, Pin } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';
import { useAIStore } from '@/stores/ai-store';
import type { PinnedPreferences, UserPreferences } from '@/lib/schemas/user-preferences';
import type { AIDisplayMode } from '@/types/ai-assistant';

const log = createLogger('settings/ai-assistant-panel');

// ============================================================================
// Learned Mission Preferences (AI-005)
// ============================================================================

interface PreferencesResponse {
  preferences: UserPreferences | null;
  /** True when the stored doc failed schema validation — Reset is the recovery path. */
  invalid?: boolean;
  topicWeights: Array<{ topic: string; actedCount: number; dismissedCount: number }> | null;
}

type PinnableField = keyof PinnedPreferences;

/** Human label for the stored structure enum. */
function structureLabel(value: UserPreferences['preferredStructure']): string {
  if (!value || value === 'none') return 'No preference detected';
  return value === 'radar' ? 'Radar landscape' : value;
}

/**
 * Read-only card surfacing the nightly-harvested mission/report preferences
 * (userPreferences/{uid}) with pin toggles on the three pinnable fields and a
 * confirm-guarded Reset. Pins are explicit overrides that survive re-harvests;
 * everything else is learned and refreshed nightly.
 */
function LearnedMissionPreferencesCard() {
  const [data, setData] = useState<PreferencesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/user/preferences');
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const payload = (await response.json()) as PreferencesResponse;
      setData(payload);
    } catch (err) {
      log.error('Failed to load learned preferences', err instanceof Error ? err : new Error(String(err)));
      setError('Could not load learned preferences.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const prefs = data?.preferences ?? null;
  const invalid = data?.invalid === true;
  const pinned = prefs?.pinned;

  /** Pin the currently-harvested value, or clear the pin (PATCH null). */
  const handlePinToggle = async (field: PinnableField, enable: boolean) => {
    if (!prefs) return;
    let value: PinnedPreferences[PinnableField] | null = null;
    if (enable) {
      if (field === 'preferredStructure') value = prefs.preferredStructure ?? 'none';
      else if (field === 'preferredCitationStyle') value = prefs.preferredCitationStyle ?? 'none';
      else value = prefs.requestsConfidenceScores;
    }
    setSaving(true);
    try {
      const response = await fetchWithAuth('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: { [field]: value } }),
      });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const payload = (await response.json()) as { preferences: UserPreferences };
      setData((prev) => ({ preferences: payload.preferences, topicWeights: prev?.topicWeights ?? null }));
    } catch (err) {
      log.error('Failed to update pin', err instanceof Error ? err : new Error(String(err)));
      setError('Could not update the pin. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      const response = await fetchWithAuth('/api/user/preferences', { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      setData((prev) => ({ preferences: null, topicWeights: prev?.topicWeights ?? null }));
    } catch (err) {
      log.error('Failed to reset preferences', err instanceof Error ? err : new Error(String(err)));
      setError('Could not reset preferences. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const pinRows: Array<{
    field: PinnableField;
    label: string;
    value: string;
    pinnable: boolean;
  }> = prefs
    ? [
        {
          field: 'preferredStructure',
          label: 'Report structure',
          value: structureLabel(pinned?.preferredStructure ?? prefs.preferredStructure),
          pinnable: (pinned?.preferredStructure ?? prefs.preferredStructure) !== undefined,
        },
        {
          field: 'preferredCitationStyle',
          label: 'Citation style',
          value:
            (pinned?.preferredCitationStyle ?? prefs.preferredCitationStyle) === 'IEEE'
              ? 'IEEE'
              : 'No preference detected',
          pinnable: (pinned?.preferredCitationStyle ?? prefs.preferredCitationStyle) !== undefined,
        },
        {
          field: 'requestsConfidenceScores',
          label: 'Confidence scores',
          value: (pinned?.requestsConfidenceScores ?? prefs.requestsConfidenceScores) ? 'Requested' : 'Not requested',
          pinnable: true,
        },
      ]
    : [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GraduationCap className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-lg">Learned Mission Preferences</CardTitle>
          </div>
          {(prefs || invalid || error) && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={saving}>
                  Reset
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset learned preferences?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This deletes the stored preference profile, including your pins. The nightly harvester will rebuild
                    the learned values from your recent mission history.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleReset()}>Reset preferences</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        <CardDescription>
          Learned nightly from your mission history. Used by mission dispatch only — chat does not read these.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : invalid ? (
          <p className="text-sm text-destructive">
            The stored preference profile is corrupted and cannot be displayed. Use Reset to clear it — the nightly
            harvester will rebuild it from your mission history.
          </p>
        ) : !prefs ? (
          <p className="text-sm text-muted-foreground">
            No learned preferences yet. The nightly harvester builds this profile from your mission history.
          </p>
        ) : (
          <>
            {pinRows.map((row) => (
              <div key={row.field} className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium">{row.label}</p>
                  <div className="flex items-center text-sm text-muted-foreground">
                    {row.value}
                    {pinned?.[row.field] !== undefined && (
                      <Badge variant="secondary" className="ml-2">
                        <Pin className="mr-1 h-3 w-3" />
                        Pinned
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor={`pin-${row.field}`} className="text-xs text-muted-foreground">
                    Pin
                  </Label>
                  <Switch
                    id={`pin-${row.field}`}
                    checked={pinned?.[row.field] !== undefined}
                    disabled={saving || (!row.pinnable && pinned?.[row.field] === undefined)}
                    onCheckedChange={(enabled) => void handlePinToggle(row.field, enabled)}
                    aria-label={`Pin ${row.label.toLowerCase()} preference`}
                  />
                </div>
              </div>
            ))}

            {prefs.topTopics.length > 0 && (
              <div>
                <p className="font-medium">Recent focus areas</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {prefs.topTopics.slice(0, 8).map((topic) => (
                    <Badge key={topic} variant="outline">
                      {topic}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {prefs.preferredAgents.length > 0 && (
              <div>
                <p className="font-medium">Most-used agents</p>
                <p className="text-sm text-muted-foreground">
                  {prefs.preferredAgents.map((a) => `${a.agent} (${a.count})`).join(' · ')}
                </p>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Analyzed {prefs.missionsAnalyzed} missions · Updated {new Date(prefs.updatedAt).toLocaleString()}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * AI Assistant settings panel component.
 *
 * Provides controls for:
 * - Display mode selection (floating button or persistent panel)
 * - Panel width configuration
 * - Notification toggle
 */
export function AIAssistantPanel() {
  const { config, setConfig } = useAIStore();

  const handleModeChange = (mode: AIDisplayMode) => {
    setConfig({ mode });
  };

  const handleWidthChange = (value: number[]) => {
    setConfig({ panelWidth: value[0] });
  };

  const handleNotificationsChange = (enabled: boolean) => {
    setConfig({ notificationsEnabled: enabled });
  };

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>AI Assistant</CardTitle>
              <CardDescription>Configure how the AI Assistant appears and behaves</CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Display Mode */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Display Mode</CardTitle>
          <CardDescription>Choose how the AI Assistant is displayed in the application</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={config.mode}
            onValueChange={(value) => handleModeChange(value as AIDisplayMode)}
            className="grid gap-4"
          >
            <div className="flex items-start space-x-3 rounded-lg border p-4 cursor-pointer hover:bg-accent/50 transition-colors">
              <RadioGroupItem
                value="floating"
                id="floating"
                className="mt-1"
                aria-label="Floating button"
              />
              <div className="space-y-1 flex-1">
                <Label htmlFor="floating" className="flex items-center gap-2 cursor-pointer">
                  <MessageCircle className="h-4 w-4" />
                  <span className="font-medium">Floating Button</span>
                </Label>
                <p className="text-sm text-muted-foreground">
                  A floating button in the bottom-right corner. Click to open the chat in a slide-out sheet.
                </p>
              </div>
            </div>
            <div className="flex items-start space-x-3 rounded-lg border p-4 cursor-pointer hover:bg-accent/50 transition-colors">
              <RadioGroupItem
                value="panel"
                id="panel"
                className="mt-1"
                aria-label="Persistent panel"
              />
              <div className="space-y-1 flex-1">
                <Label htmlFor="panel" className="flex items-center gap-2 cursor-pointer">
                  <PanelRight className="h-4 w-4" />
                  <span className="font-medium">Persistent Panel</span>
                </Label>
                <p className="text-sm text-muted-foreground">
                  A side panel that stays visible. Main content shrinks to make room.
                </p>
              </div>
            </div>
          </RadioGroup>
        </CardContent>
      </Card>

      {/* Panel Width (only for panel mode) */}
      {config.mode === 'panel' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Panel Width</CardTitle>
            <CardDescription>Adjust the width of the AI Assistant panel</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Width</Label>
                <span className="text-sm text-muted-foreground">{config.panelWidth}px</span>
              </div>
              <Slider
                value={[config.panelWidth]}
                onValueChange={handleWidthChange}
                min={300}
                max={600}
                step={50}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Narrow (300px)</span>
                <span>Wide (600px)</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Keyboard Shortcut */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Keyboard Shortcut</CardTitle>
          <CardDescription>Quick access to the AI Assistant</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Toggle AI Assistant</p>
              <p className="text-sm text-muted-foreground">Open or close the AI Assistant from anywhere in the app</p>
            </div>
            <div className="flex items-center gap-1">
              <Kbd>⌘</Kbd>
              <span className="text-muted-foreground">/</span>
              <Kbd>/</Kbd>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Learned mission preferences (AI-005) */}
      <LearnedMissionPreferencesCard />

      {/* Notifications */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Notifications</CardTitle>
          <CardDescription>Configure AI Assistant notifications</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Show notification badge</p>
              <p className="text-sm text-muted-foreground">Display a badge when the AI has suggestions or updates</p>
            </div>
            <Switch
              checked={config.notificationsEnabled}
              onCheckedChange={handleNotificationsChange}
              aria-label="Show notification badge"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
