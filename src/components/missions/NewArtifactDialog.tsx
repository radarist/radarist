'use client';

/**
 * @file NewArtifactDialog.tsx
 * @description Dispatch form for a new build artifact: the full structured
 * brief (the same contract Phase 0 validated), a budget envelope, and
 * per-stage model routing. Models left on "Platform default" fall back to
 * the IMPULSE_BUILD_MODEL_* env configuration.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useDispatchArtifact } from '@/hooks/queries/useBuildMissions';
import { useBuildCapability } from '@/hooks/queries/useBuildCapability';

const BRIEF_TEMPLATE = `# Mission: <name>

## Objective

<One sentence, measurable.>

## Context

<Who it is for, what exists already, hard constraints.>

## Must have

- <3-5 bullets max. Everything else is the agent's call.>

## Out of scope

- <Explicit non-goals.>

## Done means

- The full test suite exits 0 from a clean install.
- <2-4 runnable checks, e.g. "Playwright: search for 'enzyme' shows a filtered table".>
`;

const MODEL_OPTIONS = [
  { value: 'default', label: 'Platform default' },
  { value: 'claude-fable-5', label: 'Fable 5 (judgment-heavy)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (build workhorse)' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 (cheapest)' },
];

const STAGES = [
  { key: 'plan', label: 'Plan (00–05)' },
  { key: 'build', label: 'Build (06–07)' },
  { key: 'qa', label: 'QA review (08)' },
  { key: 'escalation', label: 'Stall escalation' },
] as const;

export function NewArtifactDialog() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(BRIEF_TEMPLATE);
  const [budgetUsd, setBudgetUsd] = useState('25');
  const [models, setModels] = useState<Record<string, string>>({});
  const dispatch = useDispatchArtifact();
  // BUILD-027 — the server gate on IMPULSE_BUILD_ENABLED, read BEFORE dispatch.
  // Only treat builds as disabled once the probe has confirmed it (`=== false`);
  // while it's loading or the probe failed, don't block — the API still enforces
  // the gate, so an unknown probe degrades to "attempt and let the API refuse"
  // rather than a dead button.
  const capability = useBuildCapability();
  const buildDisabled = capability.data?.buildEnabled === false;

  const onSubmit = () => {
    const modelOverrides = Object.fromEntries(
      Object.entries(models).filter(([, value]) => value && value !== 'default')
    );
    dispatch.mutate(
      {
        prompt,
        budgetUsd: Number(budgetUsd) || undefined,
        ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
      },
      {
        onSuccess: () => {
          toast.success('Artifact dispatched', {
            description: 'The build mission is provisioning its sandbox.',
          });
          setOpen(false);
          setPrompt(BRIEF_TEMPLATE);
          setModels({});
        },
        onError: (error) => toast.error('Dispatch failed', { description: error.message }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          className="h-9 w-9"
          data-testid="new-artifact-button"
          aria-label="New artifact"
          title="New artifact"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New artifact</DialogTitle>
          <DialogDescription>
            A complete brief produces a better build — machine-checkable &quot;Done means&quot; items become the
            acceptance gates the supervisor verifies.
          </DialogDescription>
        </DialogHeader>

        {buildDisabled && (
          <div
            role="status"
            data-testid="build-disabled-banner"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              Build missions are disabled on this instance (<code className="font-mono">IMPULSE_BUILD_ENABLED</code> is
              off). You can draft a brief, but dispatch is blocked until an operator enables it.
            </p>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <Label htmlFor="artifact-brief">Brief</Label>
            <Textarea
              id="artifact-brief"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="mt-1 h-64 font-mono text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="artifact-budget">Budget cap (USD)</Label>
              <Input
                id="artifact-budget"
                type="number"
                min="1"
                max="500"
                value={budgetUsd}
                onChange={(e) => setBudgetUsd(e.target.value)}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Typical mission: $9–14. The run pauses for a top-up when the cap is reached.
              </p>
            </div>
            <div className="space-y-2">
              {STAGES.map((stage) => (
                <div key={stage.key} className="flex items-center justify-between gap-2">
                  <Label className="text-xs">{stage.label}</Label>
                  <Select
                    value={models[stage.key] ?? 'default'}
                    onValueChange={(value) => setModels((prev) => ({ ...prev, [stage.key]: value }))}
                  >
                    <SelectTrigger className="h-8 w-44 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="text-xs">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={buildDisabled || dispatch.isPending || prompt.trim().length < 20}
            title={buildDisabled ? 'Build missions are disabled (IMPULSE_BUILD_ENABLED is off).' : undefined}
          >
            {dispatch.isPending ? 'Dispatching…' : 'Dispatch build'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
