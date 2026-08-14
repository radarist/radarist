/**
 * Capability-catalog generator. Scans skills + mission profiles + the keyless
 * research tools and emits src/lib/ai/capability-catalog.generated.ts.
 * Run via `npm run capabilities:generate`. Deterministic: regeneration is a no-op
 * (enforced by the generated-output and catalog freshness contracts).
 */
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import {
  EXPECTED_RUNTIME_SKILL_COUNT,
  RUNTIME_SKILLS_RELATIVE_DIR,
  validateRuntimeSkillPlugin,
} from '../agent/src/runtime-skill-contract';
import {
  EXCLUDED_TOOL_CLASSIFICATIONS,
  TOOL_EXCLUSION_REASONS,
  validateToolSurfacePolicy,
  type ToolExclusionReason,
} from '@/lib/ai/tool-surface-policy';

export interface CapabilitySkill {
  name: string;
  description: string;
  category: string;
}
export interface CapabilityProfile {
  name: string;
  role: string;
}
export interface CapabilityTool {
  name: string;
  summary: string;
}
export interface CapabilityFeature {
  name: string;
  summary: string;
  status: string;
}
/** One quick action of the in-app assistant surface. */
export interface AssistantQuickAction {
  action: string;
  label: string;
  prompt: string;
  /** Backing CORE_AI_TOOLS names; empty = conversational/navigation action. */
  tools: string[];
}
/** The assistant surface contract for one AIPageType. */
export interface AssistantSurfaceEntry {
  pageType: string;
  /** Mounted app routes that classify to this page type (may be empty for legacy types). */
  routes: string[];
  quickActions: AssistantQuickAction[];
}
export interface CapabilityCatalog {
  skills: CapabilitySkill[];
  profiles: CapabilityProfile[];
  tools: CapabilityTool[];
  features: CapabilityFeature[];
  /** Per-page-type assistant surface (routes, quick actions, prompts, backing tools). */
  assistantSurface?: AssistantSurfaceEntry[];
  /** The classification of every declared AI tool (core vs excluded). */
  toolSurface?: ToolSurfaceSummary;
}

/** One exclusion-reason group of the tool-surface classification. */
export interface ToolSurfaceReasonGroup {
  reason: ToolExclusionReason;
  tools: { name: string; note: string }[];
}
/** The whole tool-surface partition, ready to render deterministically. */
export interface ToolSurfaceSummary {
  total: number;
  coreCount: number;
  excludedCount: number;
  groups: ToolSurfaceReasonGroup[];
}

export interface DataSource {
  name: string;
  via: string;
  license: string;
}

/** Hand-maintained — not derived from the catalog scan. */
export const DATA_SOURCES: DataSource[] = [
  { name: 'OpenAlex', via: 'searchPapers', license: 'CC0' },
  { name: 'Crossref', via: 'searchPapers', license: 'Open (Crossref REST API)' },
  { name: 'Semantic Scholar', via: 'searchPapers', license: 'ODC-BY' },
  { name: 'Unpaywall', via: 'resolveOpenAccess', license: 'CC0 (data); email required' },
  { name: 'Hacker News (Algolia)', via: 'searchHackerNews', license: 'MIT API, public data' },
  { name: 'SEC EDGAR', via: 'searchSecFilings', license: 'US-gov public domain' },
  { name: 'Ecosyste.ms', via: 'searchOssHealth', license: 'CC-BY-SA 4.0 (attribution required)' },
  { name: 'Google Patents', via: 'searchPatents', license: 'Public patent data (keyless)' },
];

/**
 * Hand-maintained — platform-level mission/artifact machinery the assistant
 * should be able to name and explain. Not derived from the catalog scan
 * (mission kinds and tiers have no SKILL.md/config.yaml to scan). `status`
 * must stay HONEST: a flag-gated feature is described as such so the
 * assistant never promises a surface the deployment has off.
 */
export const PLATFORM_FEATURES: CapabilityFeature[] = [
  {
    name: 'research-missions',
    summary:
      "Multi-agent research missions (kind 'research') run by the mission profiles — dispatched from chat via startMission; produce reports, verdicts, and graph updates tracked live on the Agent Runs page.",
    status: 'live',
  },
  {
    name: 'build-missions',
    summary:
      "Experimental sandboxed prototyping. The path is default-off and excluded from the qualified v0.1 surface because its sandbox image and external executable bundle are not fully pinned. Do not use it for sensitive or reproducible work.",
    status: 'experimental; default-off; not qualified or supported in v0.1',
  },
  {
    name: 'limitless-build-mode',
    summary:
      'Experimental higher-budget build mode layered on the unqualified build sandbox. It is default-off and outside the supported v0.1 prototype surface.',
    status: 'experimental; default-off; not qualified or supported in v0.1',
  },
  {
    name: 'technology-evaluations',
    summary:
      'Experimental hands-on evaluation implemented through the unqualified build sandbox. Ordinary assessment and radar triage remain available without enabling this path.',
    status: 'experimental; default-off; not qualified or supported in v0.1',
  },
];

/** Curated skill → category map. Unmapped skills fall to 'General'. */
export const CATEGORY_BY_SKILL: Record<string, string> = {
  // Research & evidence
  'research-technology': 'Research & evidence',
  'research-company': 'Research & evidence',
  'systematic-review': 'Research & evidence',
  'decompose-research-question': 'Research & evidence',
  'triangulate-sources': 'Research & evidence',
  'grounded-answer': 'Research & evidence',
  'grounded-fact-check': 'Research & evidence',
  'verify-citations': 'Research & evidence',
  'cite-ieee': 'Research & evidence',
  'claim-provenance': 'Research & evidence',
  'rate-source-admiralty': 'Research & evidence',
  'sift-source-check': 'Research & evidence',
  'graph-as-instrument': 'Research & evidence',
  'oss-project-health': 'Research & evidence',
  // Analysis & forecasting
  'apply-hype-cycle': 'Analysis & forecasting',
  'three-horizons': 'Analysis & forecasting',
  foresight: 'Analysis & forecasting',
  'scenario-planning': 'Analysis & forecasting',
  'five-forces-analysis': 'Analysis & forecasting',
  'position-competitor': 'Analysis & forecasting',
  'jtbd-framing': 'Analysis & forecasting',
  'estimate-market-size': 'Analysis & forecasting',
  'evolution-stage': 'Analysis & forecasting',
  'score-technology-readiness': 'Analysis & forecasting',
  'cynefin-classification': 'Analysis & forecasting',
  'analysis-of-competing-hypotheses': 'Analysis & forecasting',
  'assess-research-momentum': 'Analysis & forecasting',
  'bayesian-update': 'Analysis & forecasting',
  'brier-score-calibration': 'Analysis & forecasting',
  'weak-signal-triage': 'Analysis & forecasting',
  // Critique & red-team
  'red-team-claim': 'Critique & rigor',
  'premortem-analysis': 'Critique & rigor',
  'critique-report': 'Critique & rigor',
  'abstain-or-escalate': 'Critique & rigor',
  'assess-study-bias': 'Critique & rigor',
  'quantitative-sanity-check': 'Critique & rigor',
  'test-significance': 'Critique & rigor',
  'benchmark-model-claims': 'Critique & rigor',
  'cheapest-experiment': 'Critique & rigor',
  'key-assumptions-check': 'Critique & rigor',
  'steelman-argument': 'Critique & rigor',
  // Domain checks
  'chemistry-claim-check': 'Domain checks',
  'smiles-sanity-check': 'Domain checks',
  'analyze-patent-claims': 'Domain checks',
  'analyze-release-notes': 'Domain checks',
  'detect-funding-round': 'Domain checks',
  'detect-ma-event': 'Domain checks',
  'read-patent-landscape': 'Domain checks',
  // Reporting & radar
  'generate-radar-report': 'Reporting & radar',
  'write-imrad-report': 'Reporting & radar',
  'write-srl-brief': 'Reporting & radar',
  'pyramid-principle': 'Reporting & radar',
  'design-pass': 'Reporting & radar',
  'evaluate-signal': 'Reporting & radar',
  'discover-relations': 'Reporting & radar',
  'verify-entity': 'Reporting & radar',
};

const MAX_TOOL_SUMMARY = 160;

/**
 * Read a single-line scalar field from a YAML frontmatter block by regex
 * rather than full parsing. Some SKILL.md descriptions contain an embedded
 * ": " (e.g. "SOFT (fail-open): it records...") — a legitimate plain scalar
 * that trips yaml.load()'s block-mapping parser but is unambiguous read
 * line-by-line. Mirrors `readScalar()` in scripts/build-skill-prompts.ts,
 * the sibling script that already parses these same files this way.
 */
function readScalarFallback(frontmatter: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const m = frontmatter.match(re);
  if (!m) return undefined;
  let value = m[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : undefined;
}

/**
 * Extract + YAML-parse the leading `---`…`---` frontmatter of a markdown file.
 * Falls back to per-field regex extraction (readScalarFallback) when the
 * fence isn't strict YAML — see readScalarFallback for why that happens.
 */
function parseFrontmatter(md: string): Record<string, unknown> | null {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fence = m[1];
  try {
    const doc = yaml.load(fence);
    if (doc && typeof doc === 'object') return doc as Record<string, unknown>;
  } catch {
    // fall through to the regex fallback below
  }
  const name = readScalarFallback(fence, 'name');
  const description = readScalarFallback(fence, 'description');
  return name || description ? { name, description } : null;
}

function readSkills(skillsDir: string): CapabilitySkill[] {
  const out: CapabilitySkill[] = [];
  if (!fs.existsSync(skillsDir)) return out;
  const productSkillsDir = path.resolve(__dirname, '..', RUNTIME_SKILLS_RELATIVE_DIR);
  if (path.resolve(skillsDir) === productSkillsDir) {
    return validateRuntimeSkillPlugin(path.dirname(productSkillsDir)).map((skill) => ({
      name: skill.name,
      description: skill.description,
      category: CATEGORY_BY_SKILL[skill.name] ?? 'General',
    }));
  }
  for (const dirent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const file = path.join(skillsDir, dirent.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const name = typeof fm?.name === 'string' ? fm.name.trim() : '';
    const description = typeof fm?.description === 'string' ? fm.description.trim() : '';
    if (!name || !description || name !== dirent.name) {
      console.warn(`[catalog] skipping skill dir '${dirent.name}' — missing name/description frontmatter`);
      continue;
    }
    out.push({ name, description, category: CATEGORY_BY_SKILL[name] ?? 'General' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a mission-profile config.yaml into a plain object. Falls back to
 * per-field regex extraction (readScalarFallback) when the file isn't strict
 * YAML — mirrors parseFrontmatter's fallback for SKILL.md frontmatter, for
 * the same reason (an unquoted description containing ": " trips
 * yaml.load()'s block-mapping parser). config.yaml has no `---` fence, so
 * the whole file text is passed to readScalarFallback directly.
 */
function parseProfileConfig(text: string): Record<string, unknown> | null {
  try {
    const doc = yaml.load(text);
    if (doc && typeof doc === 'object') return doc as Record<string, unknown>;
  } catch {
    // fall through to the regex fallback below
  }
  const name = readScalarFallback(text, 'name');
  const description = readScalarFallback(text, 'description');
  return name || description ? { name, description } : null;
}

function readProfiles(agentsDir: string): CapabilityProfile[] {
  const out: CapabilityProfile[] = [];
  if (!fs.existsSync(agentsDir)) throw new Error(`[catalog] profile directory is missing: ${agentsDir}`);
  for (const dirent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const file = path.join(agentsDir, dirent.name, 'config.yaml');
    if (!fs.existsSync(file)) {
      throw new Error(`[catalog] profile '${dirent.name}' has no config.yaml`);
    }
    const doc = parseProfileConfig(fs.readFileSync(file, 'utf8'));
    const name = typeof doc?.name === 'string' ? doc.name.trim() : '';
    const role = typeof doc?.description === 'string' ? doc.description.trim() : '';
    if (!name || !role) {
      throw new Error(`[catalog] profile '${dirent.name}' is missing name/description in config.yaml`);
    }
    if (name !== dirent.name) {
      throw new Error(`[catalog] profile '${dirent.name}' declares mismatched name '${name}'`);
    }
    out.push({ name, role });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildCatalog(opts: {
  skillsDir: string;
  agentsDir: string;
  tools: CapabilityTool[];
  /** Pass buildAssistantSurface(srcRoot); optional so existing callers/tests are unaffected. */
  assistantSurface?: AssistantSurfaceEntry[];
}): CapabilityCatalog {
  return {
    skills: readSkills(opts.skillsDir),
    profiles: readProfiles(opts.agentsDir),
    tools: opts.tools,
    features: PLATFORM_FEATURES,
    ...(opts.assistantSurface ? { assistantSurface: opts.assistantSurface } : {}),
  };
}

/**
 * Build the "Assistant surface" contract by walking the mounted app routes
 * (same walker as the assistant-route-coverage gate — src/lib/ai/route-inventory.ts,
 * so the two cannot fork), classify each via the extracted page classifier, and
 * join per AIPageType with the quick actions, their chat prompts, and the
 * backing CORE tools. Deterministic: page types in declaration order, routes
 * sorted, actions in production order (entity-context actions first).
 */
export async function buildAssistantSurface(
  srcRoot: string,
  assertReadable?: (absolutePath: string) => void
): Promise<AssistantSurfaceEntry[]> {
  const { scanRouteInventory, concretePath } = await import('@/lib/ai/route-inventory');
  const { getPageTypeFromPath } = await import('@/lib/ai/page-context');
  const { ALL_AI_PAGE_TYPES, getQuickActionsForContext, QUICK_ACTION_MESSAGES, QUICK_ACTION_TOOLS } =
    await import('@/lib/ai/assistant-surface');

  const buckets = scanRouteInventory(srcRoot, assertReadable);
  const routesByType = new Map<string, string[]>();
  for (const route of [...buckets.mounted].sort()) {
    const pageType = getPageTypeFromPath(concretePath(route));
    const bucket = routesByType.get(pageType);
    if (bucket) bucket.push(route);
    else routesByType.set(pageType, [route]);
  }

  return ALL_AI_PAGE_TYPES.map((pageType) => {
    const seen = new Set<string>();
    const quickActions: AssistantQuickAction[] = [];
    // Union over both entity states — entity-detail's actions only appear with
    // an entity in context; everything else is state-independent.
    for (const hasEntity of [true, false]) {
      for (const action of getQuickActionsForContext(pageType, hasEntity)) {
        if (seen.has(action.action)) continue;
        seen.add(action.action);
        quickActions.push({
          action: action.action,
          label: action.label,
          prompt: QUICK_ACTION_MESSAGES[action.action] ?? '',
          tools: QUICK_ACTION_TOOLS[action.action] ?? [],
        });
      }
    }
    return { pageType, routes: routesByType.get(pageType) ?? [], quickActions };
  });
}

export function renderCatalogModule(catalog: CapabilityCatalog): string {
  const body = JSON.stringify(catalog, null, 2);
  return `// GENERATED FILE — DO NOT EDIT. Run \`npm run capabilities:generate\`.
// Source: agent/runtime-plugin/skills/*/SKILL.md, agent/agents/*/config.yaml, PRIMARY_SOURCE_TOOLS, PLATFORM_FEATURES.

export interface CapabilitySkill {
  name: string;
  description: string;
  category: string;
}
export interface CapabilityProfile {
  name: string;
  role: string;
}
export interface CapabilityTool {
  name: string;
  summary: string;
}
export interface CapabilityFeature {
  name: string;
  summary: string;
  status: string;
}
export interface AssistantQuickAction {
  action: string;
  label: string;
  prompt: string;
  tools: string[];
}
export interface AssistantSurfaceEntry {
  pageType: string;
  routes: string[];
  quickActions: AssistantQuickAction[];
}
export interface CapabilityCatalog {
  skills: CapabilitySkill[];
  profiles: CapabilityProfile[];
  tools: CapabilityTool[];
  features: CapabilityFeature[];
  assistantSurface?: AssistantSurfaceEntry[];
}

export const CAPABILITY_CATALOG: CapabilityCatalog = ${body};
`;
}

/** First non-empty line of a tool description, trimmed to MAX_TOOL_SUMMARY. */
export function toSummary(description: string): string {
  const first =
    description
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return first.length > MAX_TOOL_SUMMARY ? `${first.slice(0, MAX_TOOL_SUMMARY - 1).trimEnd()}…` : first;
}

interface SkillCategoryGroup {
  category: string;
  skills: CapabilitySkill[];
}

/** Group skills by category: categories sorted by name, skills sorted by name within each. */
function groupSkillsByCategory(skills: CapabilitySkill[]): SkillCategoryGroup[] {
  const byCategory = new Map<string, CapabilitySkill[]>();
  for (const skill of skills) {
    const bucket = byCategory.get(skill.category);
    if (bucket) bucket.push(skill);
    else byCategory.set(skill.category, [skill]);
  }
  return Array.from(byCategory.entries())
    .map(([category, categorySkills]) => ({
      category,
      skills: [...categorySkills].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Render the concise markdown fragment sandwiched between the README
 * capability markers. Deterministic — see groupSkillsByCategory; profiles
 * and tools render in catalog/declared order.
 */
export function renderReadmeBlock(catalog: CapabilityCatalog): string {
  const groups = groupSkillsByCategory(catalog.skills);
  const categoryLines = groups
    .map((g) => `- **${g.category}** (${g.skills.length}) — ${g.skills.map((s) => s.name).join(', ')}`)
    .join('\n');
  const profileLine = catalog.profiles.map((p) => p.name).join(' · ');
  const toolLine = catalog.tools.map((t) => t.name).join(' · ');
  const featureLine = catalog.features.map((f) => f.name).join(' · ');
  const sourceNames = DATA_SOURCES.map((d) => d.name).join(', ');
  return `_Generated from the capability catalog — do not edit between the markers; run \`npm run capabilities:generate\`._

**${catalog.skills.length} analytical skills** across ${groups.length} categories:

${categoryLines}

**${catalog.profiles.length} mission profiles** — ${profileLine}

**${catalog.tools.length} keyless research tools** — ${toolLine} (no API key required)

**${catalog.features.length} platform features** — ${featureLine} (see \`docs/CAPABILITIES.md\` for status)

**Keyless data sources** — ${sourceNames}. Data: Ecosyste.ms (CC-BY-SA 4.0).`;
}

/**
 * Build the tool-surface classification from the committed snapshot
 * ({all, core} names, kept fresh by the tool-surface-policy contract test) and
 * the exclusion policy. THROWS if the partition is not total+disjoint (a tool
 * missing a classification, an exclusion naming a non-existent tool, or a tool
 * marked both core and excluded) — so a stale/incorrect surface fails generation,
 * not just tests. The generator can't import the tool barrel directly: it pulls
 * `server-only` via the admin executors, hence the snapshot indirection.
 */
export function buildToolSurface(snapshot: { all: string[]; core: string[] }): ToolSurfaceSummary {
  const validation = validateToolSurfacePolicy(snapshot.all, snapshot.core);
  if (!validation.ok) {
    throw new Error(`[catalog] tool-surface classification is invalid:\n  - ${validation.errors.join('\n  - ')}`);
  }
  const groups: ToolSurfaceReasonGroup[] = TOOL_EXCLUSION_REASONS.map((reason) => ({
    reason,
    tools: Object.entries(EXCLUDED_TOOL_CLASSIFICATIONS)
      .filter(([, c]) => c.reason === reason)
      .map(([name, c]) => ({ name, note: c.note }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
  const core = new Set(snapshot.core);
  return {
    total: snapshot.all.length,
    coreCount: snapshot.all.filter((n) => core.has(n)).length,
    excludedCount: Object.keys(EXCLUDED_TOOL_CLASSIFICATIONS).length,
    groups,
  };
}

const TOOL_EXCLUSION_REASON_LABELS: Record<ToolExclusionReason, string> = {
  'server-only': 'Server-only (mission / pipeline context)',
  deferred: 'Deferred (held off pending verification or owned by a UI lane)',
  safety: 'Safety (raw Cypher, bulk/cascade or unreviewed writes)',
  unsupported: 'Unsupported (superseded / duplicate of a canonical core tool)',
};

/**
 * Render the "Assistant tool surface" doc section: the core/excluded
 * split and every excluded tool grouped by reason. Empty string when the catalog
 * carries no tool surface (unit-test fixtures) so legacy renders are unchanged.
 */
function renderToolSurfaceSection(surface: ToolSurfaceSummary | undefined): string {
  if (!surface) return '';
  const groupSections = surface.groups
    .filter((g) => g.tools.length > 0)
    .map((g) => {
      const lines = g.tools.map((t) => `- **${t.name}** — ${t.note}`).join('\n');
      return `### ${TOOL_EXCLUSION_REASON_LABELS[g.reason]} (${g.tools.length})\n\n${lines}`;
    })
    .join('\n\n');
  return `
## Assistant tool surface (${surface.total} declared)

_Every declared AI tool is exactly one classification: **core** (offered to the chat model and external MCP — \`CORE_AI_TOOLS\`) or one exclusion reason below. The partition is enforced by \`src/lib/ai/tool-surface-policy.ts\` and its contract test; this classification does not change any authorization or confirmation boundary._

**${surface.coreCount} core** · **${surface.excludedCount} excluded** across ${surface.groups.filter((g) => g.tools.length > 0).length} reasons.

${groupSections}
`;
}

/** Render the full docs/CAPABILITIES.md body. Deterministic — see renderReadmeBlock. */
export function renderCapabilitiesDoc(catalog: CapabilityCatalog): string {
  const groups = groupSkillsByCategory(catalog.skills);
  const skillSections = groups
    .map((g) => {
      const lines = g.skills.map((s) => `- **${s.name}** — ${s.description}`).join('\n');
      return `### ${g.category} (${g.skills.length})\n\n${lines}`;
    })
    .join('\n\n');
  const profileLines = catalog.profiles.map((p) => `- **${p.name}** — ${p.role}`).join('\n');
  const toolLines = catalog.tools.map((t) => `- **${t.name}** — ${t.summary}`).join('\n');
  const featureLines = catalog.features.map((f) => `- **${f.name}** — ${f.summary} _(${f.status})_`).join('\n');
  const sourceRows = DATA_SOURCES.map((d) => `| ${d.name} | ${d.via} | ${d.license} |`).join('\n');
  const assistantSection = renderAssistantSurfaceSection(catalog.assistantSurface);
  const toolSurfaceSection = renderToolSurfaceSection(catalog.toolSurface);
  return `> GENERATED FILE — do not edit by hand. Run \`npm run capabilities:generate\`.

# Radarist Capabilities

## Skills (${catalog.skills.length})

${skillSections}

## Mission profiles (${catalog.profiles.length})

${profileLines}

## Keyless research tools (${catalog.tools.length})

${toolLines}

## Platform features (${catalog.features.length})

${featureLines}
${assistantSection}${toolSurfaceSection}
## Keyless-by-default data sources

| Source | Tool | License |
| --- | --- | --- |
${sourceRows}
`;
}

/**
 * Render the "Assistant surface" doc section: per AIPageType, the
 * mounted routes that classify to it, the quick actions offered there, each
 * action's chat prompt, and its backing CORE tools. Empty string when the
 * catalog carries no surface (unit-test fixtures) so legacy renders are
 * byte-identical.
 */
function renderAssistantSurfaceSection(surface: AssistantSurfaceEntry[] | undefined): string {
  if (!surface || surface.length === 0) return '';
  const sections = surface
    .map((entry) => {
      const routes =
        entry.routes.length > 0
          ? entry.routes.map((r) => `\`${r}\``).join(', ')
          : '_none (legacy/redirected page type)_';
      const actions = entry.quickActions
        .map((qa) => {
          const backing =
            qa.tools.length > 0
              ? `backed by ${qa.tools.map((t) => `\`${t}\``).join(', ')}`
              : 'conversational/navigation — no single backing tool';
          return `- **${qa.label}** (\`${qa.action}\`) — "${qa.prompt}" _(${backing})_`;
        })
        .join('\n');
      return `### \`${entry.pageType}\`\n\nRoutes: ${routes}\n\n${actions}`;
    })
    .join('\n\n');
  return `
## Assistant surface (${surface.length} page types)

_The in-app AI assistant classifies every mounted route to a page type (\`src/lib/ai/page-context.ts\`) and offers these quick actions (\`src/lib/ai/assistant-surface.ts\`). Generated from the same route walker as the assistant-route-coverage CI gate._

${sections}
`;
}

export const README_START = '<!-- CAPABILITIES:START -->';
export const README_END = '<!-- CAPABILITIES:END -->';

/** Escape regex metacharacters so a literal marker string is safe inside `new RegExp`. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the text between README_START and README_END (markers preserved,
 * block sandwiched with surrounding newlines). Throws if either marker is
 * absent — the README must carry both markers before this can run.
 */
export function replaceReadmeRegion(readme: string, block: string): string {
  if (!readme.includes(README_START) || !readme.includes(README_END)) {
    throw new Error(`replaceReadmeRegion: README is missing the ${README_START} / ${README_END} markers`);
  }
  const region = new RegExp(`${escapeRegExp(README_START)}[\\s\\S]*?${escapeRegExp(README_END)}`);
  return readme.replace(region, `${README_START}\n${block}\n${README_END}`);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const { PRIMARY_SOURCE_TOOLS } = await import('@/lib/ai/tools/primary-source-tools');
  const tools: CapabilityTool[] = PRIMARY_SOURCE_TOOLS.map((t) => ({
    name: t.name,
    summary: toSummary(String(t.description ?? '')),
  }));
  const assistantSurface = await buildAssistantSurface(path.join(repoRoot, 'src'));
  // Validate and classify the tool surface from the committed snapshot.
  // buildToolSurface THROWS on any partition drift, failing generation.
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'src/lib/ai/tool-surface.generated.json'), 'utf8')
  ) as { all: string[]; core: string[] };
  const toolSurface = buildToolSurface(snapshot);
  const catalog = buildCatalog({
    skillsDir: path.join(repoRoot, RUNTIME_SKILLS_RELATIVE_DIR),
    agentsDir: path.join(repoRoot, 'agent/agents'),
    tools,
    assistantSurface,
  });
  if (catalog.skills.length !== EXPECTED_RUNTIME_SKILL_COUNT) {
    throw new Error(
      `Runtime skill count mismatch: expected ${EXPECTED_RUNTIME_SKILL_COUNT}, found ${catalog.skills.length}`
    );
  }
  const outFile = path.join(repoRoot, 'src/lib/ai/capability-catalog.generated.ts');
  // The runtime catalog module stays lean (no tool surface); the classification
  // is a docs-only concern rendered from the same validated data below.
  fs.writeFileSync(outFile, renderCatalogModule(catalog));
  console.log(
    `[catalog] wrote ${outFile}: ${catalog.skills.length} skills, ${catalog.profiles.length} profiles, ${catalog.tools.length} tools, ${catalog.features.length} features, ${assistantSurface.length} assistant page types; tool surface ${toolSurface.coreCount} core / ${toolSurface.excludedCount} excluded`
  );

  const capsDoc = renderCapabilitiesDoc({ ...catalog, toolSurface });
  fs.writeFileSync(path.join(repoRoot, 'docs/CAPABILITIES.md'), capsDoc);
  const readmePath = path.join(repoRoot, 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  fs.writeFileSync(readmePath, replaceReadmeRegion(readme, renderReadmeBlock(catalog)));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[catalog] generation failed', err);
    process.exit(1);
  });
}
