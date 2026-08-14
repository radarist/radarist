/**
 * @file ai/tools/capability-tools.ts
 * @description On-demand capability-discovery tools for the Gemini chat assistant.
 * `listCapabilities` / `describeCapability` read the generated capability catalog
 * (src/lib/ai/capability-catalog.generated.ts) so the assistant can name and explain
 * what the platform can do, and suggest a mission profile to act on it. No runtime fs,
 * no external calls — pure reads over the committed catalog.
 */
import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { createLogger } from '@/lib/logger';
import { CAPABILITY_CATALOG } from '@/lib/ai/capability-catalog.generated';
import { DISPATCHABLE_MISSION_AGENTS } from '@/lib/types/agents';
import type { ToolResult } from './tool-result';

const log = createLogger('ai/capability-tools');

export const CAPABILITY_TOOLS: FunctionDeclaration[] = [
  {
    name: 'listCapabilities',
    description: `List what this platform (Radarist) can actually do — its analytical skills, mission agent profiles, keyless research tools, and platform features (mission kinds and build tiers) — from a machine-generated catalog.

WHEN TO USE THIS TOOL:
- The user asks "what can you do", "what are your capabilities", "how would you research X", "what skills/tools do you have"
- The user asks about platform machinery — missions, build missions/prototyping, the Limitless build tier, technology evaluations
- You want to ground a recommendation in the platform's real, named capabilities instead of guessing
- Before proposing an approach, to check which skills/profiles fit the user's goal

WITH a query: returns matching skills/profiles/tools/features plus a suggested mission profile. WITHOUT a query: returns the full catalog grouped by category with counts. Each platform feature carries an honest status (e.g. flag-gated) — relay that status rather than promising a gated feature is available. This is a read of the real catalog — never invent skills, profiles, tools, or features that are not returned here.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            'Optional topic/goal to filter capabilities by (e.g. "patent landscape", "market size", "oss health"). Omit for the full grouped catalog.',
        },
      },
      required: [],
    },
  },
  {
    name: 'describeCapability',
    description: `Explain one named capability — a skill, mission profile, research tool, or platform feature (e.g. "build-missions", "limitless-build-mode") — from the platform's generated catalog.

WHEN TO USE THIS TOOL:
- The user (or you, after listCapabilities) references a capability by name and you need its one-line description/role
- You want to confirm a capability exists before recommending it

Returns the capability's kind + description (platform features also carry an honest availability status — relay it). If the name isn't found, returns found:false with near matches — do not fabricate a description for a capability that isn't in the catalog.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: 'The capability name to describe (e.g. "apply-hype-cycle", "scout", "searchPapers").',
        },
      },
      required: ['name'],
    },
  },
];

const norm = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

function suggestProfile(query: string): string {
  const q = query.toLowerCase();
  // DISC-002: only ever suggest profiles startMission will actually accept —
  // suggesting a catalog-listed but undispatchable profile (defense-minister,
  // which only the verification pipeline dispatches) sent the assistant's own
  // "just ask" hint into a guaranteed thrown error.
  const names = new Set(
    CAPABILITY_CATALOG.profiles.map((p) => p.name).filter((n) => DISPATCHABLE_MISSION_AGENTS.has(n))
  );
  const pick = (name: string): string | undefined => (names.has(name) ? name : undefined);
  let candidate: string | undefined;
  if (/report|write|brief|infographic|visual/.test(q)) candidate = pick('creator');
  else if (/strateg|prioriti|invest|decision|roadmap/.test(q)) candidate = pick('strategist');
  else if (/relation|link|graph|connect/.test(q)) candidate = pick('linker');
  // Verification-shaped queries route to evaluator: defense-minister exists but
  // is not user-dispatchable, and evaluator is the closest evidence-first profile.
  else if (/verif|validat|fact|evidence|defen/.test(q)) candidate = pick('evaluator');
  else if (/evaluat|assess|score|placement|readiness/.test(q)) candidate = pick('evaluator');
  else candidate = pick('scout');
  return candidate ?? [...names][0] ?? 'scout';
}

export function executeListCapabilities(args: { query?: string }): ToolResult {
  try {
    const query = (args.query ?? '').trim();
    if (!query) {
      const byCategory = new Map<string, string[]>();
      for (const s of CAPABILITY_CATALOG.skills) {
        const arr = byCategory.get(s.category) ?? [];
        arr.push(s.name);
        byCategory.set(s.category, arr);
      }
      const categories = [...byCategory.entries()]
        .map(([category, skills]) => ({
          category,
          count: skills.length,
          skills: skills.sort((a, b) => a.localeCompare(b)),
        }))
        .sort((a, b) => a.category.localeCompare(b.category));
      return {
        success: true,
        data: {
          categories,
          profiles: CAPABILITY_CATALOG.profiles,
          tools: CAPABILITY_CATALOG.tools,
          features: CAPABILITY_CATALOG.features,
          totals: {
            skills: CAPABILITY_CATALOG.skills.length,
            profiles: CAPABILITY_CATALOG.profiles.length,
            tools: CAPABILITY_CATALOG.tools.length,
            features: CAPABILITY_CATALOG.features.length,
          },
        },
      };
    }
    const q = query.toLowerCase();
    const has = (...parts: string[]): boolean => parts.some((p) => p.toLowerCase().includes(q));
    const skills = CAPABILITY_CATALOG.skills.filter((s) => has(s.name, s.description));
    const profiles = CAPABILITY_CATALOG.profiles.filter((p) => has(p.name, p.role));
    const tools = CAPABILITY_CATALOG.tools.filter((t) => has(t.name, t.summary));
    const features = CAPABILITY_CATALOG.features.filter((f) => has(f.name, f.summary, f.status));
    const suggestedProfile = suggestProfile(query);
    return {
      success: true,
      data: {
        query,
        matches: { skills, profiles, tools, features },
        suggestedProfile,
        hint: `To act on this, I can run it as a mission (e.g. a ${suggestedProfile} mission) — just ask.`,
      },
    };
  } catch (err) {
    log.error('executeListCapabilities failed', err instanceof Error ? err : undefined, { query: args.query });
    return { success: false, error: err instanceof Error ? err.message : 'listCapabilities failed' };
  }
}

export function executeDescribeCapability(args: { name: string }): ToolResult {
  try {
    const target = norm(args.name ?? '');
    if (!target) return { success: false, error: 'describeCapability requires a name' };
    const skill = CAPABILITY_CATALOG.skills.find((s) => norm(s.name) === target);
    if (skill)
      return {
        success: true,
        data: { kind: 'skill', name: skill.name, description: skill.description, category: skill.category },
      };
    const profile = CAPABILITY_CATALOG.profiles.find((p) => norm(p.name) === target);
    if (profile) return { success: true, data: { kind: 'profile', name: profile.name, role: profile.role } };
    const tool = CAPABILITY_CATALOG.tools.find((t) => norm(t.name) === target);
    if (tool) return { success: true, data: { kind: 'tool', name: tool.name, summary: tool.summary } };
    const feature = CAPABILITY_CATALOG.features.find((f) => norm(f.name) === target);
    if (feature)
      return {
        success: true,
        data: { kind: 'feature', name: feature.name, summary: feature.summary, status: feature.status },
      };
    const allNames = [
      ...CAPABILITY_CATALOG.skills.map((s) => s.name),
      ...CAPABILITY_CATALOG.profiles.map((p) => p.name),
      ...CAPABILITY_CATALOG.tools.map((t) => t.name),
      ...CAPABILITY_CATALOG.features.map((f) => f.name),
    ];
    const nearMatches = allNames.filter((n) => norm(n).includes(target) || target.includes(norm(n))).slice(0, 5);
    return { success: true, data: { found: false, query: args.name, nearMatches } };
  } catch (err) {
    log.error('executeDescribeCapability failed', err instanceof Error ? err : undefined, { name: args.name });
    return { success: false, error: err instanceof Error ? err.message : 'describeCapability failed' };
  }
}
