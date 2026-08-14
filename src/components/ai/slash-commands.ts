/**
 * @file slash-commands.ts
 * @description Registry for the chat input's `/`-command menu. A few built-in
 * action templates plus every capability-catalog skill as `/skill-name`. Pure —
 * no React. Selecting a command seeds the input with its `template`; the user
 * reviews and sends, and the normal chat plumbing (listCapabilities / research
 * tools / renderDiagram) does the rest.
 */
import { CAPABILITY_CATALOG } from '@/lib/ai/capability-catalog.generated';
import { MISSION_PRESETS } from '@/lib/mission-presets';

/**
 * lucide-react icon component names the slash menu may use. ChatInput's
 * SLASH_ICONS is typed `Record<SlashIconName, …>`, so the compiler forces the
 * two files to stay in parity: a name here that ChatInput doesn't render (or a
 * missing key there) is a type error, not a silent Wand2 fallback.
 */
export type SlashIconName = 'Sparkles' | 'Search' | 'Network' | 'Wand2' | 'FileText';

export interface SlashCommand {
  id: string;
  /** Display text, e.g. '/research'. */
  label: string;
  description: string;
  /** lucide-react icon component name (mapped in ChatInput). */
  icon: SlashIconName;
  /** Inserted into the input on select. */
  template: string;
  /** Present for catalog-skill commands: the skill name. */
  capability?: string;
  /** Present for mission-preset commands: the preset id (see mission-presets.ts). */
  preset?: string;
}

/** Built-ins that don't come from the skills catalog. */
const BUILTINS: SlashCommand[] = [
  {
    id: 'capabilities',
    label: '/capabilities',
    description: 'List what the assistant can do — skills, tools, and mission profiles',
    icon: 'Sparkles',
    template: 'What can you do? List your capabilities and skills.',
  },
  {
    id: 'research',
    label: '/research',
    description: 'Deep-research a technology with primary sources (papers, HN, filings)',
    icon: 'Search',
    template: 'Research the following technology and cite primary sources: ',
  },
  {
    id: 'diagram',
    label: '/diagram',
    description: 'Render a data-driven diagram (echarts / mermaid)',
    icon: 'Network',
    template: 'Create a diagram of: ',
  },
  {
    id: 'build',
    label: '/build',
    description: 'Build a working app prototype in a sandboxed build mission (confirm scope + spend first)',
    icon: 'Wand2',
    template:
      'Build a working prototype (sandboxed build mission — draft the brief with an Objective, Must-have features, Out of scope, and a "Done means" acceptance list, then confirm the scope and spend with me before dispatching) of: ',
  },
  {
    id: 'limitless',
    label: '/limitless',
    description: 'Premium build tier - Opus/max-effort builder plus an independent Opus reviewer, $40 + $10 caps',
    icon: 'Wand2',
    template:
      'Build a working prototype on the Limitless premium tier (one Opus/max-effort builder capped at $40, handing off at phase 08 to one fresh independent Opus reviewer with a protected $10 cap, under one shared $50 mission cap with no automatic top-up or resume - draft the brief with an Objective, Must-have features, Out of scope, a "Done means" acceptance list, and a Design Brief with real on-subject content, a committed palette + type, and responsive + accessible design, then stage the exact server-verified $50 confirmation phrase and wait for me to send it on the next turn before dispatching) of: ',
  },
];

/** All commands: built-ins first, then catalog skills sorted by name. */
export function getSlashCommands(): SlashCommand[] {
  const skills = [...CAPABILITY_CATALOG.skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<SlashCommand>((s) => ({
      id: s.name,
      label: `/${s.name}`,
      description: s.description,
      icon: 'Wand2',
      template: `Use the ${s.name} approach to: `,
      capability: s.name,
    }));
  const presets = MISSION_PRESETS.map<SlashCommand>((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    icon: 'FileText',
    template: p.seed,
    preset: p.id,
  }));
  return [...BUILTINS, ...presets, ...skills];
}

/** Case-insensitive substring match over id + description. Empty query → all. */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const all = getSlashCommands();
  if (!q) return all;
  return all.filter((c) => c.id.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
}
