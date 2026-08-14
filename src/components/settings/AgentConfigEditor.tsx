/**
 * @file AgentConfigEditor.tsx
 * @description Background automation policy and agent runtime configuration.
 *
 * The master background-automation switch and Impulse per-cycle cap persist to
 * system config. Agent models, budgets, tool limits, and server cron schedules
 * are runtime-owned and therefore rendered read-only.
 *
 * @created 2026-02-23
 * @updated 2026-06-10
 */

'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Save, RotateCcw, RefreshCw, Timer, Coins, Cpu, Radio, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  getSystemConfig,
  resetSignalSourcesToSupportedDefaults,
  updateBackgroundAutomationConfig,
} from '@/lib/system-config';
import {
  computeEffectiveSourceStates,
  hasEnabledUnavailableSources,
  type EffectiveSourceState,
} from '@/lib/signal-source-availability';
import { useAgentProfiles } from '@/hooks/queries/useAgentProfiles';
import type { SweepConfig } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/AgentConfigEditor');

/** Query key for the persisted sweep slice of the system-config doc */
const SWEEP_CONFIG_QUERY_KEY = ['system-config', 'sweep'] as const;

/** Query key for the persisted signal-source enablement map (SETTINGS-003) */
const SIGNAL_SOURCES_QUERY_KEY = ['system-config', 'signal-sources'] as const;

// ============================================================================
// AGENT MODEL TABLE (live data from /api/agents/profiles)
// ============================================================================

/** One read-only row of runtime agent configuration. */
interface AgentRowConfig {
  /** Canonical agent name from config.yaml (e.g. 'defense-minister'). */
  key: string;
  label: string;
  description: string;
  model: string;
  modelSource: 'config' | 'env';
  tokenBudget: number;
  toolCallLimit: number;
}

/** 'defense-minister' → 'Defense Minister', 'scout' → 'Scout' */
function agentDisplayName(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const DEFAULT_SWEEP_CONFIG = {
  maxActionsPerSweep: 10,
  enabled: false,
} as const;

interface AutomationPanelState {
  maxActionsPerSweep: number;
  enabled: boolean;
  linkerEnabled: boolean;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}k`;
  }
  return String(tokens);
}

function AgentRowsSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border p-3">
          <div className="min-w-0 sm:w-40 shrink-0 space-y-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-36" />
          </div>
          <Skeleton className="h-8 flex-1" />
          <Skeleton className="h-8 w-28 shrink-0" />
          <Skeleton className="h-8 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * Visual editor for agent configuration.
 *
 * Renders:
 * - Background automation master policy and Impulse per-cycle cap, persisted
 *   to the system-config Firestore document
 * - Read-only per-agent model, budget, and tool limits loaded from the live
 *   runtime configuration
 * - Read-only server schedule provenance
 * - Mission controls — enforced cost/tool-call caps and the configured token
 *   telemetry reference from the mission runner
 */
export function AgentConfigEditor() {
  const queryClient = useQueryClient();

  // Persisted sweep slice of the singleton system-config doc. Falls back to
  // defaults while loading or when the doc predates the sweep field.
  const { data: persistedAutomation, isLoading: isLoadingSweep } = useQuery({
    queryKey: SWEEP_CONFIG_QUERY_KEY,
    queryFn: async (): Promise<AutomationPanelState> => {
      const config = await getSystemConfig();
      return {
        enabled: config.sweep?.enabled === true,
        maxActionsPerSweep: config.sweep?.maxActionsPerSweep ?? DEFAULT_SWEEP_CONFIG.maxActionsPerSweep,
        linkerEnabled: config.linkerAgent?.enabled === true,
      };
    },
  });

  // Persisted signal-source map → persisted-vs-effective state (SETTINGS-003).
  // A source an upgraded store left enabled but that cannot produce signals
  // (retired patents endpoint, fetcher-less funding/trends) is shown as
  // Unavailable with an actionable reason so the operator can reset before
  // enabling the automation master.
  const {
    data: sourceStates,
    isLoading: isLoadingSources,
    isError: isSourceStatesError,
    refetch: refetchSources,
  } = useQuery({
    queryKey: SIGNAL_SOURCES_QUERY_KEY,
    queryFn: async (): Promise<EffectiveSourceState[]> => {
      const config = await getSystemConfig();
      return computeEffectiveSourceStates(config.signalDetection?.sources);
    },
  });
  const [isResettingSources, setIsResettingSources] = useState(false);
  const enabledUnavailable = sourceStates
    ? hasEnabledUnavailableSources(Object.fromEntries(sourceStates.map((s) => [s.source, s.persisted])))
    : false;

  const handleResetSources = useCallback(async () => {
    try {
      setIsResettingSources(true);
      await resetSignalSourcesToSupportedDefaults();
      await refetchSources();
      toast.success('Signal sources reset to supported defaults', {
        description: 'Unavailable sources (patents, funding, trends) are now disabled.',
      });
    } catch (error) {
      log.error('Failed to reset signal sources', error instanceof Error ? error : new Error(String(error)));
      toast.error('Failed to reset signal sources');
    } finally {
      setIsResettingSources(false);
    }
  }, [refetchSources]);

  // Live agent profiles + mission budget — the runtime ground truth.
  const {
    data: profilesData,
    isLoading: isLoadingProfiles,
    error: profilesError,
    refetch: refetchProfiles,
  } = useAgentProfiles();

  const liveAgents: AgentRowConfig[] = (profilesData?.profiles ?? []).map((p) => ({
    key: p.name,
    label: agentDisplayName(p.name),
    description: p.description,
    model: p.model,
    modelSource: p.modelSource,
    tokenBudget: p.maxTokens,
    toolCallLimit: p.maxToolCalls,
  }));

  // Saved baseline: persisted values for the wired fields, defaults otherwise.
  const baseSweep: AutomationPanelState = {
    enabled: persistedAutomation?.enabled ?? DEFAULT_SWEEP_CONFIG.enabled,
    maxActionsPerSweep: persistedAutomation?.maxActionsPerSweep ?? DEFAULT_SWEEP_CONFIG.maxActionsPerSweep,
    linkerEnabled: persistedAutomation?.linkerEnabled ?? false,
  };

  // Local drafts — null/empty means "no unsaved edits, show the live baseline".
  const [sweepDraft, setSweepDraft] = useState<AutomationPanelState | null>(null);
  const sweep = sweepDraft ?? baseSweep;
  const [isSaving, setIsSaving] = useState(false);

  const updateSweep = (updates: Partial<AutomationPanelState>) => {
    // Never seed a draft while the persisted config is still loading — the
    // baseline would be the fallback defaults, and once the query resolves
    // the draft would shadow the real persisted values (and Save would then
    // silently overwrite them). The controls are disabled while loading; this
    // guard is the belt to that suspender.
    if (isLoadingSweep) return;
    setSweepDraft((prev) => ({ ...(prev ?? baseSweep), ...updates }));
  };

  // Only persisted fields can make the editor dirty.
  const sweepDirty =
    sweep.enabled !== baseSweep.enabled ||
    sweep.maxActionsPerSweep !== baseSweep.maxActionsPerSweep ||
    sweep.linkerEnabled !== baseSweep.linkerEnabled;
  const sweepAtDefaults =
    sweep.enabled === DEFAULT_SWEEP_CONFIG.enabled &&
    sweep.maxActionsPerSweep === DEFAULT_SWEEP_CONFIG.maxActionsPerSweep &&
    sweep.linkerEnabled === false;

  const handleSave = useCallback(async () => {
    try {
      setIsSaving(true);
      const next: SweepConfig = {
        enabled: sweep.enabled,
        maxActionsPerSweep: sweep.maxActionsPerSweep,
      };
      await updateBackgroundAutomationConfig(next, sweep.linkerEnabled);
      // Update the cached baseline so the panel reflects the saved state.
      queryClient.setQueryData(SWEEP_CONFIG_QUERY_KEY, { ...next, linkerEnabled: sweep.linkerEnabled });
      toast.success('Background automation settings saved', {
        description: 'The master policy, Linker switch, and Impulse cap take effect on the next scheduled run.',
      });
    } catch (error) {
      log.error('Failed to save sweep configuration', error instanceof Error ? error : new Error(String(error)));
      toast.error('Failed to save background automation settings');
    } finally {
      setIsSaving(false);
    }
  }, [sweep.enabled, sweep.maxActionsPerSweep, sweep.linkerEnabled, queryClient]);

  const handleReset = useCallback(() => {
    setSweepDraft({ ...DEFAULT_SWEEP_CONFIG, linkerEnabled: false });
  }, []);

  const missionBudget = profilesData?.missionBudget;

  return (
    <div className="space-y-6">
      {/* Per-Agent Runtime Configuration */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Cpu className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Agent Runtime Configuration</CardTitle>
                <CardDescription>
                  Read-only values loaded from <code className="text-xs">agent/agents/*/config.yaml</code> and runtime
                  environment overrides.
                </CardDescription>
              </div>
            </div>
            {liveAgents.length > 0 && (
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {liveAgents.length} configured agents
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingProfiles ? (
            <AgentRowsSkeleton />
          ) : profilesError || liveAgents.length === 0 ? (
            <div className="flex items-center justify-between rounded-lg border border-dashed p-4">
              <p className="text-sm text-muted-foreground">
                Could not load the live agent configs. Retry, or check the server logs.
              </p>
              <Button variant="outline" size="sm" onClick={() => void refetchProfiles()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {liveAgents.map((agent) => (
                <div
                  key={agent.key}
                  role="group"
                  aria-label={`${agent.label} runtime configuration`}
                  className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border p-3"
                >
                  {/* Agent info */}
                  <div className="min-w-0 sm:w-40 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium">{agent.label}</p>
                      {agent.modelSource === 'env' && (
                        <Badge variant="outline" className="text-[10px]">
                          env
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{agent.description}</p>
                  </div>

                  {/* Runtime model */}
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-muted-foreground">Model</p>
                    <p className="text-xs font-mono truncate" title={agent.model}>
                      {agent.model}
                    </p>
                  </div>

                  {/* Runtime token reference */}
                  <div className="w-28 shrink-0">
                    <p className="text-[10px] text-muted-foreground">Token reference</p>
                    <p className="text-xs font-mono">{formatTokens(agent.tokenBudget)} tokens</p>
                  </div>

                  {/* Runtime tool-call limit */}
                  <div className="w-24 shrink-0">
                    <p className="text-[10px] text-muted-foreground">Tool limit</p>
                    <p className="text-xs font-mono">{agent.toolCallLimit} calls</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Signal Sources — persisted vs effective state + guarded reset (SETTINGS-003) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Radio className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Signal Sources</CardTitle>
                <CardDescription>
                  What each external source is <em>saved</em> as versus what it can <em>actually</em> do. Some sources
                  an upgraded configuration left enabled can no longer produce signals; reset to the supported defaults
                  before enabling Background Automation.
                </CardDescription>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleResetSources()}
              disabled={isLoadingSources || isSourceStatesError || !sourceStates || isResettingSources}
              aria-label="Reset signal sources to supported defaults"
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              {isResettingSources ? 'Resetting…' : 'Reset to supported defaults'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {enabledUnavailable && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
              <p className="text-xs">
                One or more <strong>enabled</strong> sources cannot produce signals. Enabling Background Automation will
                not surface them — reset to supported defaults to make the saved state match what actually runs.
              </p>
            </div>
          )}
          {isLoadingSources ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : isSourceStatesError || !sourceStates ? (
            <div
              role="alert"
              aria-label="Signal sources unavailable"
              className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div>
                  <p className="text-sm font-medium">Could not load signal source state</p>
                  <p className="text-xs text-muted-foreground">
                    The saved and effective source status is unavailable. Retry after the local data service is ready.
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetchSources()}
                aria-label="Retry loading signal sources"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {sourceStates.map((state) => (
                <div
                  key={state.source}
                  role="group"
                  aria-label={`${state.label} signal source`}
                  className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{state.label}</span>
                      <Badge variant={state.persisted ? 'default' : 'secondary'} className="text-[10px]">
                        Saved: {state.persisted ? 'Enabled' : 'Disabled'}
                      </Badge>
                      {state.available ? (
                        <Badge variant={state.effective ? 'default' : 'outline'} className="text-[10px]">
                          Effective: {state.effective ? 'Active' : 'Inactive'}
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="text-[10px]">
                          Unavailable
                        </Badge>
                      )}
                    </div>
                    {!state.available && state.reason && (
                      <p className="mt-1 text-xs text-muted-foreground">{state.reason}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Background Automation */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Timer className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Background Automation</CardTitle>
              <CardDescription>
                Permission for scheduled signal fetching, discovery, Linker proposals, and Impulse missions. Each
                capability keeps its own gate; the master is paused by default.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Enabled Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="sweep-enabled">Run Background Automation</Label>
                <Badge variant={sweep.enabled ? 'default' : 'secondary'}>{sweep.enabled ? 'Enabled' : 'Paused'}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                When paused, gated scheduled runs and their manual job events exit without doing work. Direct,
                user-initiated review and editing remain available.
              </p>
            </div>
            <Switch
              id="sweep-enabled"
              checked={sweep.enabled}
              onCheckedChange={(checked) => updateSweep({ enabled: checked })}
              disabled={isLoadingSweep}
              aria-label="Run background automation"
            />
          </div>

          <div className="flex items-center justify-between border-t pt-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="linker-enabled">Relationship Linker</Label>
                <Badge variant={sweep.enabled && sweep.linkerEnabled ? 'default' : 'secondary'}>
                  {sweep.enabled && sweep.linkerEnabled ? 'Active' : sweep.linkerEnabled ? 'Waiting for master' : 'Off'}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Proposes relationships for review every six hours. It never auto-approves proposals.
              </p>
            </div>
            <Switch
              id="linker-enabled"
              checked={sweep.linkerEnabled}
              onCheckedChange={(checked) => updateSweep({ linkerEnabled: checked })}
              disabled={isLoadingSweep}
              aria-label="Enable relationship linker"
            />
          </div>

          {/* Server-owned schedules */}
          <div className="space-y-1.5 border-t pt-4">
            <Label>Runtime Schedules</Label>
            <p className="text-xs text-muted-foreground">
              Server-controlled. Signal fetching and relationship linking run every 6 hours. Impulse sweep defaults to
              every 6 hours via <code>SWEEP_CRON</code>; discovery defaults to 01:30 and 13:30 UTC via{' '}
              <code>DISCOVERY_SWEEP_CRON</code>.
            </p>
          </div>

          {/* Max Actions Slider */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Max Impulse Actions Per Cycle</Label>
              <span className="text-sm font-mono text-muted-foreground">{sweep.maxActionsPerSweep}</span>
            </div>
            <Slider
              value={[sweep.maxActionsPerSweep]}
              onValueChange={([value]) => updateSweep({ maxActionsPerSweep: value })}
              min={1}
              max={20}
              step={1}
              disabled={isLoadingSweep}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>1 action</span>
              <span>20 actions</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Upper bound on actions the Impulse sweep plans per cycle. The server-side{' '}
              <code>SWEEP_MAX_MISSIONS_PER_CYCLE</code> cap (default 2) also applies — the lower value wins.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Mission Cost Controls (real, enforced caps — display-only) */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Coins className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Mission Cost Controls</CardTitle>
              <CardDescription>
                Enforced cost/tool-call caps and the configured token reference from the mission runner. Display-only —
                change them via environment variables.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingProfiles ? (
            <div className="grid gap-4 md:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : missionBudget ? (
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <p className="text-lg font-semibold">${missionBudget.maxCostUsd.toFixed(2)}</p>
                  {missionBudget.maxCostSource === 'env' && (
                    <Badge variant="outline" className="text-[10px]">
                      env override
                    </Badge>
                  )}
                </div>
                <p className="text-xs font-medium mt-0.5">Per-mission cost cap</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Hard cap — the agent SDK aborts a mission when its reported spend exceeds this. Env:{' '}
                  <code>MISSION_MAX_COST_USD</code>
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-lg font-semibold">{formatTokens(missionBudget.tokenBudget)} tokens</p>
                <p className="text-xs font-medium mt-0.5">Configured token reference</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Observed for telemetry only; this does not stop a mission. Env: <code>MISSION_TOKEN_BUDGET</code>
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-lg font-semibold">{missionBudget.maxToolCalls} tool calls</p>
                <p className="text-xs font-medium mt-0.5">Per-mission tool-call cap</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Enforced by the mission budget hooks. Env: <code>MISSION_MAX_TOOL_CALLS</code>
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Could not load the live mission controls. The defaults are a $15.00 per-mission cost cap, a configured
              50k-token reference, and 100 tool calls.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Save/Reset Actions */}
      <div className="flex items-center justify-between pt-2">
        <Button variant="outline" size="sm" onClick={handleReset} disabled={isLoadingSweep || sweepAtDefaults}>
          <RotateCcw className="h-4 w-4 mr-2" />
          Reset to Defaults
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!sweepDirty || isSaving}>
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? 'Saving...' : 'Save Automation Settings'}
        </Button>
      </div>
    </div>
  );
}
