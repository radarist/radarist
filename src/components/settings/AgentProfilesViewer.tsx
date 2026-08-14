/**
 * @file AgentProfilesViewer.tsx
 * @description Read-only viewer for agent profiles, fed by live config data.
 *
 * Models, budgets, and MCP server lists come from /api/agents/profiles, which
 * parses `agent/agents/<name>/config.yaml` at request time — the same files the
 * mission runtime loads (env model overrides applied). Only the personality
 * blurbs and icons are local presentation metadata.
 *
 * @created 2026-02-23
 * @updated 2026-06-10
 */

'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import {
  Search,
  Scale,
  Link2,
  BookOpen,
  Lightbulb,
  FileText,
  ShieldCheck,
  Bot,
  Server,
  Cpu,
  Coins,
  RefreshCw,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAgentProfiles } from '@/hooks/queries/useAgentProfiles';
import type { AgentProfileSummary } from '@/hooks/queries/useAgentProfiles';

// ============================================================================
// PRESENTATION METADATA (personality + icon only — runtime facts come from API)
// ============================================================================

interface AgentPresentation {
  role: string;
  personality: string;
  icon: LucideIcon;
}

const AGENT_PRESENTATION: Record<string, AgentPresentation> = {
  scout: {
    role: 'The Curious Explorer',
    personality:
      'Endlessly curious. Loves discovering things nobody else has noticed. Casts a wide net, reports fast, flags uncertainty.',
    icon: Search,
  },
  evaluator: {
    role: 'The Rigorous Analyst',
    personality: 'Methodical and evidence-driven. Demands proof before conclusions. Separates hype from substance.',
    icon: Scale,
  },
  linker: {
    role: 'The Connection Finder',
    personality:
      'Sees patterns everywhere. Connects the dots between seemingly unrelated entities. Validates relationships with evidence.',
    icon: Link2,
  },
  curator: {
    role: 'The Quality Guardian',
    personality:
      'Detail-oriented perfectionist. Ensures every entity is complete and consistent. Fills gaps proactively.',
    icon: BookOpen,
  },
  strategist: {
    role: 'The Pattern Thinker',
    personality: 'Thinks in systems. Sees the big picture. Connects individual findings into strategic narratives.',
    icon: Lightbulb,
  },
  creator: {
    role: 'The Report Crafter',
    personality: 'Articulate and design-conscious. Transforms raw data into polished, actionable deliverables.',
    icon: FileText,
  },
  'defense-minister': {
    role: 'The Skeptical Verifier',
    personality:
      'Trusts nothing without a source. Continuously re-verifies entities, hunts stale facts, and checks claims against the live web.',
    icon: ShieldCheck,
  },
};

const FALLBACK_PRESENTATION: AgentPresentation = {
  role: 'Agent',
  personality: '',
  icon: Bot,
};

/** 'defense-minister' → 'Defense Minister', 'scout' → 'Scout' */
function displayName(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}k`;
  }
  return String(tokens);
}

function ProfilesGridSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 7 }).map((_, i) => (
        <Card key={i} className="flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 rounded-lg shrink-0" />
              <div className="space-y-1.5 min-w-0 flex-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 space-y-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AgentProfileCard({ profile }: { profile: AgentProfileSummary }) {
  const presentation = AGENT_PRESENTATION[profile.name] ?? FALLBACK_PRESENTATION;
  const IconComponent = presentation.icon;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <IconComponent className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-base">{displayName(profile.name)}</CardTitle>
            <CardDescription className="text-xs">{presentation.role}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
        {/* Personality (presentation) or live description */}
        <p className="text-sm text-muted-foreground">{presentation.personality || profile.description}</p>

        {/* Model (live, env override applied) */}
        <div className="flex items-center gap-2 text-sm">
          <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-mono text-xs">{profile.model}</span>
          {profile.modelSource === 'env' && (
            <Badge variant="outline" className="text-[10px]">
              env override
            </Badge>
          )}
        </div>

        {/* Effective runtime limits (live) */}
        <div className="flex items-center gap-2 text-sm">
          <Coins className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground">
            Effective: {formatTokens(profile.maxTokens)} token reference / {profile.maxToolCalls} tool calls
          </span>
        </div>

        {/* MCP Servers (live) */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Server className="h-3 w-3 shrink-0" />
            <span>MCP Servers</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {profile.internalMcpServers.map((server) => (
              <Badge key={server} variant="secondary" className="text-[10px] font-mono">
                {server}
              </Badge>
            ))}
            {profile.externalMcpServers.map((server) => (
              <Badge key={server} variant="outline" className="text-[10px] font-mono">
                {server}
              </Badge>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Read-only viewer for the agent profiles.
 *
 * Displays each agent as a card showing:
 * - Name and role
 * - Personality description (presentation metadata)
 * - Live model assignment (config.yaml, env override applied)
 * - Live MCP server connections (internal: solid, external: outlined)
 * - Live budget limits (max tokens and tool calls)
 */
export function AgentProfilesViewer() {
  const { data, isLoading, error, refetch } = useAgentProfiles();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each agent has a distinct personality, model assignment, and set of capabilities. Model, budget, and MCP-server
        data is read live from <code className="text-xs bg-muted px-1 py-0.5 rounded">agent/agents/*/config.yaml</code>{' '}
        — the same files the mission runtime loads (per-agent{' '}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">IMPULSE_AGENT_*_MODEL</code> env overrides applied).
      </p>

      {isLoading ? (
        <ProfilesGridSkeleton />
      ) : error || !data ? (
        <EmptyState
          icon={Bot}
          title="Could not load agent profiles"
          description="The live agent config files could not be read. Retry, or check the server logs."
          action={{ label: 'Retry', onClick: () => void refetch(), icon: RefreshCw }}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.profiles.map((profile) => (
            <AgentProfileCard key={profile.name} profile={profile} />
          ))}
        </div>
      )}
    </div>
  );
}
