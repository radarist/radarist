/**
 * @jest-environment node
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCatalog, renderCatalogModule, CATEGORY_BY_SKILL } from '../generate-capability-catalog';
import { RUNTIME_SKILL_NAMES } from '../../agent/src/runtime-skill-contract';
import {
  renderReadmeBlock,
  renderCapabilitiesDoc,
  replaceReadmeRegion,
  README_START,
  README_END,
  DATA_SOURCES,
  PLATFORM_FEATURES,
} from '../generate-capability-catalog';

/** Write a minimal skill dir with YAML frontmatter. */
function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

/** Write a minimal profile dir with a config.yaml. */
function writeProfile(root: string, name: string, description: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    `name: ${name}\ndescription: '${description}'\nmodel: claude-sonnet-4-6\n`
  );
}

describe('buildCatalog', () => {
  let tmp: string;
  let skillsDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
    skillsDir = path.join(tmp, 'skills');
    agentsDir = path.join(tmp, 'agents');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const tools = [{ name: 'searchPapers', summary: 'Search academic literature' }];

  it('parses skill frontmatter, assigns categories, and sorts skills by name', () => {
    writeSkill(skillsDir, 'zeta-skill', 'Last alphabetically');
    writeSkill(skillsDir, 'apply-hype-cycle', 'Maturity arc diagnostic');
    const cat = buildCatalog({ skillsDir, agentsDir, tools });
    expect(cat.skills.map((s) => s.name)).toEqual(['apply-hype-cycle', 'zeta-skill']);
    expect(cat.skills[0].description).toBe('Maturity arc diagnostic');
    // Known skill → mapped category; unknown → 'General'
    expect(cat.skills.find((s) => s.name === 'apply-hype-cycle')!.category).toBe(CATEGORY_BY_SKILL['apply-hype-cycle']);
    expect(cat.skills.find((s) => s.name === 'zeta-skill')!.category).toBe('General');
  });

  it('parses profile config.yaml into name+role and sorts by name', () => {
    writeProfile(agentsDir, 'scout', 'Discovers new signals and technologies');
    writeProfile(agentsDir, 'creator', 'Produces reports and infographics');
    const cat = buildCatalog({ skillsDir, agentsDir, tools });
    expect(cat.profiles.map((p) => p.name)).toEqual(['creator', 'scout']);
    expect(cat.profiles.find((p) => p.name === 'scout')!.role).toBe('Discovers new signals and technologies');
  });

  it('recovers a profile config.yaml whose unquoted description contains ": " via the regex fallback', () => {
    // Unquoted scalar with an embedded ": " trips yaml.load()'s block-mapping
    // parser (bad indentation of a mapping entry) — mirrors the SKILL.md
    // frontmatter case parseFrontmatter already falls back for.
    const dir = path.join(agentsDir, 'quirky');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      'name: quirky\ndescription: SOFT (fail-open): it records the verdict but never blocks shipping\nmodel: claude-sonnet-4-6\n'
    );
    const cat = buildCatalog({ skillsDir, agentsDir, tools });
    const profile = cat.profiles.find((p) => p.name === 'quirky');
    expect(profile).toBeDefined();
    expect(profile!.role).toBe('SOFT (fail-open): it records the verdict but never blocks shipping');
  });

  it('fails closed when a profile is malformed, missing its config, or names a different directory', () => {
    fs.mkdirSync(path.join(agentsDir, 'missing-config'));
    expect(() => buildCatalog({ skillsDir, agentsDir, tools })).toThrow('has no config.yaml');
    fs.rmSync(path.join(agentsDir, 'missing-config'), { recursive: true });

    fs.mkdirSync(path.join(agentsDir, 'malformed'));
    fs.writeFileSync(path.join(agentsDir, 'malformed', 'config.yaml'), 'name: malformed\n');
    expect(() => buildCatalog({ skillsDir, agentsDir, tools })).toThrow('missing name/description');
    fs.rmSync(path.join(agentsDir, 'malformed'), { recursive: true });

    writeProfile(agentsDir, 'declared-name', 'Role');
    fs.renameSync(path.join(agentsDir, 'declared-name'), path.join(agentsDir, 'directory-name'));
    expect(() => buildCatalog({ skillsDir, agentsDir, tools })).toThrow("declares mismatched name 'declared-name'");
  });

  it('carries the tools through in declaration order', () => {
    const cat = buildCatalog({ skillsDir, agentsDir, tools });
    expect(cat.tools).toEqual(tools);
  });

  it('always includes the hand-maintained platform features', () => {
    const cat = buildCatalog({ skillsDir, agentsDir, tools });
    expect(cat.features).toEqual(PLATFORM_FEATURES);
    expect(cat.features.map((f) => f.name)).toEqual(
      expect.arrayContaining(['research-missions', 'build-missions', 'limitless-build-mode', 'technology-evaluations'])
    );
  });

  it('skips a skill dir with no readable frontmatter (no throw), warning instead', () => {
    fs.mkdirSync(path.join(skillsDir, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'broken', 'SKILL.md'), '# no frontmatter\n');
    writeSkill(skillsDir, 'good-skill', 'fine');
    const cat = buildCatalog({ skillsDir, agentsDir, tools });
    expect(cat.skills.map((s) => s.name)).toEqual(['good-skill']);
  });

  it('renderCatalogModule is deterministic (idempotent) and imports the interface type', () => {
    writeSkill(skillsDir, 'good-skill', 'fine');
    writeProfile(agentsDir, 'scout', 'Discovers things');
    const cat = buildCatalog({ skillsDir, agentsDir, tools });
    const a = renderCatalogModule(cat);
    const b = renderCatalogModule(buildCatalog({ skillsDir, agentsDir, tools }));
    expect(a).toBe(b);
    expect(a).toContain('export const CAPABILITY_CATALOG: CapabilityCatalog =');
    expect(a).toContain('GENERATED FILE — DO NOT EDIT');
  });
});

describe('buildCatalog against the real repo dirs', () => {
  it('covers the skills dir minus the non-servable developer skills', () => {
    const skillsDir = path.resolve(__dirname, '../../agent/runtime-plugin/skills');
    const agentsDir = path.resolve(__dirname, '../../agent/agents');
    const tools = [{ name: 'searchPapers', summary: 'x' }];
    const cat = buildCatalog({ skillsDir, agentsDir, tools });
    const skillDirCount = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md'))).length;

    expect(cat.skills.length).toBe(skillDirCount);
    expect(cat.skills.map((skill) => skill.name)).toEqual([...RUNTIME_SKILL_NAMES].sort());
    expect(Object.keys(CATEGORY_BY_SKILL).sort()).toEqual([...RUNTIME_SKILL_NAMES].sort());
    expect(cat.skills.length).toBeGreaterThan(40);
    expect(cat.profiles.length).toBeGreaterThanOrEqual(6);
  });
});

const FIXTURE = {
  skills: [
    { name: 'apply-hype-cycle', description: 'Maturity arc', category: 'Analysis & forecasting' },
    { name: 'oss-project-health', description: 'Repo vitality', category: 'Research & evidence' },
    { name: 'research-technology', description: 'Deep research', category: 'Research & evidence' },
  ],
  profiles: [
    { name: 'scout', role: 'Discovers signals' },
    { name: 'creator', role: 'Writes reports' },
  ],
  tools: [{ name: 'searchPapers', summary: 'Academic search' }],
  features: [
    { name: 'build-missions', summary: 'Sandboxed autonomous prototyping', status: 'flag-gated (default off)' },
    { name: 'limitless-build-mode', summary: 'Premium build tier', status: 'opt-in per mission' },
  ],
};

describe('PLATFORM_FEATURES', () => {
  it('states the v0.1 support boundary on every build-path feature', () => {
    const buildGated = PLATFORM_FEATURES.filter((f) => f.name !== 'research-missions');
    expect(buildGated.length).toBeGreaterThanOrEqual(3);
    for (const feature of buildGated) {
      expect(feature.status).toBe('experimental; default-off; not qualified or supported in v0.1');
      expect(feature.summary).toMatch(/experimental/i);
    }
    expect(PLATFORM_FEATURES.find((f) => f.name === 'research-missions')!.status).toBe('live');
  });
});

describe('DATA_SOURCES', () => {
  it('includes Ecosyste.ms with a CC-BY-SA attribution', () => {
    const eco = DATA_SOURCES.find((d) => d.name === 'Ecosyste.ms');
    expect(eco).toBeTruthy();
    expect(eco!.license).toMatch(/CC-BY-SA/);
  });
});

describe('renderReadmeBlock', () => {
  it('renders category counts, profile + tool names, and the CC-BY-SA line, deterministically', () => {
    const a = renderReadmeBlock(FIXTURE);
    const b = renderReadmeBlock({ ...FIXTURE });
    expect(a).toBe(b); // deterministic
    expect(a).toContain('3 analytical skills');
    expect(a).toContain('**Research & evidence** (2)');
    expect(a).toContain('oss-project-health'); // sorted within category
    expect(a).toContain('scout');
    expect(a).toContain('searchPapers');
    expect(a).toContain('2 platform features');
    expect(a).toContain('limitless-build-mode');
    expect(a).toContain('Ecosyste.ms (CC-BY-SA 4.0)');
    // categories sorted: Analysis & forecasting before Research & evidence
    expect(a.indexOf('Analysis & forecasting')).toBeLessThan(a.indexOf('Research & evidence'));
  });
});

describe('renderCapabilitiesDoc', () => {
  it('emits a generated-file header, per-category skill sections, profiles, tools, and a data-source table', () => {
    const doc = renderCapabilitiesDoc(FIXTURE);
    expect(doc).toContain('# Radarist Capabilities');
    expect(doc).toMatch(/GENERATED FILE/i);
    expect(doc).toContain('### Research & evidence (2)');
    expect(doc).toContain('- **research-technology** — Deep research');
    expect(doc).toContain('- **scout** — Discovers signals');
    expect(doc).toContain('## Platform features (2)');
    expect(doc).toContain('- **build-missions** — Sandboxed autonomous prototyping _(flag-gated (default off))_');
    expect(doc).toContain('| Ecosyste.ms |');
  });
});

describe('replaceReadmeRegion', () => {
  it('replaces only the text between the markers, preserving them', () => {
    const readme = `# Title\nintro\n${README_START}\nOLD\n${README_END}\ntail`;
    const out = replaceReadmeRegion(readme, 'NEW BLOCK');
    expect(out).toContain(README_START);
    expect(out).toContain(README_END);
    expect(out).toContain('NEW BLOCK');
    expect(out).not.toContain('OLD');
    expect(out.startsWith('# Title\nintro')).toBe(true);
    expect(out.trimEnd().endsWith('tail')).toBe(true);
  });
  it('is idempotent', () => {
    const readme = `${README_START}\nX\n${README_END}`;
    const once = replaceReadmeRegion(readme, 'BLOCK');
    expect(replaceReadmeRegion(once, 'BLOCK')).toBe(once);
  });
  it('throws when a marker is missing', () => {
    expect(() => replaceReadmeRegion('no markers here', 'B')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Assistant surface section
// ---------------------------------------------------------------------------

import { buildAssistantSurface } from '../generate-capability-catalog';
import type { AssistantSurfaceEntry } from '../generate-capability-catalog';

describe('buildAssistantSurface (against the real repo)', () => {
  const srcRoot = path.resolve(__dirname, '../../src');
  let surface: AssistantSurfaceEntry[];

  beforeAll(async () => {
    surface = await buildAssistantSurface(srcRoot);
  });

  it('covers every AIPageType exactly once, in declaration order', () => {
    const types = surface.map((e) => e.pageType);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain('dashboard');
    expect(types).toContain('insights');
    expect(types.length).toBeGreaterThanOrEqual(19);
  });

  it('maps mounted routes onto their page types via the shared walker + classifier', () => {
    const byType = new Map(surface.map((e) => [e.pageType, e]));
    expect(byType.get('dashboard')!.routes).toContain('/dashboard');
    expect(byType.get('radar')!.routes).toEqual(expect.arrayContaining(['/radar', '/visualizations/radar']));
    expect(byType.get('reports')!.routes).toEqual(expect.arrayContaining(['/reports']));
    // No mounted route may be silently dropped: every mounted route appears somewhere.
    const allRoutes = surface.flatMap((e) => e.routes);
    expect(allRoutes).toContain('/artifacts');
  });

  it('joins quick actions with prompts and backing tools', () => {
    const reports = surface.find((e) => e.pageType === 'reports')!;
    const listReports = reports.quickActions.find((a) => a.action === 'list_reports')!;
    expect(listReports.prompt).toBe('List my recent reports');
    expect(listReports.tools).toEqual(expect.arrayContaining(['listReports']));
    // entity-detail actions (entity-gated) are unioned in
    const entityDetail = surface.find((e) => e.pageType === 'entity-detail')!;
    expect(entityDetail.quickActions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['research_entity', 'find_relations', 'summarize_entity', 'navigation_help'])
    );
  });

  it('is deterministic (two builds serialize identically)', async () => {
    const again = await buildAssistantSurface(srcRoot);
    expect(JSON.stringify(again)).toBe(JSON.stringify(surface));
  });
});

describe('renderCapabilitiesDoc with an assistant surface', () => {
  const SURFACE_FIXTURE: AssistantSurfaceEntry[] = [
    {
      pageType: 'reports',
      routes: ['/reports', '/reports/[id]'],
      quickActions: [
        { action: 'list_reports', label: 'List Reports', prompt: 'List my recent reports', tools: ['listReports'] },
        { action: 'navigation_help', label: 'Navigate', prompt: 'Help me navigate the platform', tools: [] },
      ],
    },
    { pageType: 'signals', routes: [], quickActions: [] },
  ];

  it('renders the section with routes, prompts, and backing tools', () => {
    const doc = renderCapabilitiesDoc({ ...FIXTURE, assistantSurface: SURFACE_FIXTURE });
    expect(doc).toContain('## Assistant surface (2 page types)');
    expect(doc).toContain('### `reports`');
    expect(doc).toContain('`/reports/[id]`');
    expect(doc).toContain('backed by `listReports`');
    expect(doc).toContain('conversational/navigation — no single backing tool');
    expect(doc).toContain('_none (legacy/redirected page type)_');
  });

  it('renders byte-identically without a surface (legacy fixtures unaffected)', () => {
    expect(renderCapabilitiesDoc(FIXTURE)).not.toContain('## Assistant surface');
  });
});

// ---------------------------------------------------------------------------
// Tool-surface classification
// ---------------------------------------------------------------------------

import { buildToolSurface } from '../generate-capability-catalog';

// buildToolSurface validates the WHOLE surface against the full exclusion policy,
// so a valid input must be the real committed snapshot — a subset would flag the
// unreferenced policy entries as "unknown". This mirrors how the generator runs.
const REAL_SNAPSHOT = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'src/lib/ai/tool-surface.generated.json'), 'utf8')
) as { all: string[]; core: string[] };

describe('buildToolSurface', () => {
  it('classifies the real snapshot into a total, disjoint partition', () => {
    const surface = buildToolSurface(REAL_SNAPSHOT);
    expect(surface.total).toBe(REAL_SNAPSHOT.all.length);
    expect(surface.coreCount).toBe(REAL_SNAPSHOT.core.length);
    expect(surface.coreCount + surface.excludedCount).toBe(surface.total);
    const byReason = Object.fromEntries(surface.groups.map((g) => [g.reason, g.tools.map((t) => t.name)]));
    expect(byReason.safety).toContain('executeCypher');
    expect(byReason['server-only']).toContain('draftDocument');
    expect(byReason.deferred).toContain('askGraphQuestion');
    expect(byReason.unsupported).toContain('researchTechnology');
  });

  it('THROWS when the snapshot has an unclassified tool (fails generation)', () => {
    expect(() => buildToolSurface({ all: [...REAL_SNAPSHOT.all, 'brandNewTool'], core: REAL_SNAPSHOT.core })).toThrow(
      /unclassified/i
    );
  });

  it('THROWS when an excluded tool is also marked core (conflicting)', () => {
    expect(() => buildToolSurface({ all: REAL_SNAPSHOT.all, core: [...REAL_SNAPSHOT.core, 'executeCypher'] })).toThrow(
      /both core and excluded/i
    );
  });
});

describe('renderCapabilitiesDoc with a tool surface', () => {
  it('renders the classification section with core/excluded counts and reason groups', () => {
    const surface = buildToolSurface(REAL_SNAPSHOT);
    const doc = renderCapabilitiesDoc({ ...FIXTURE, toolSurface: surface });
    expect(doc).toContain(`## Assistant tool surface (${surface.total} declared)`);
    expect(doc).toContain(`**${surface.coreCount} core**`);
    expect(doc).toContain('### Safety');
    expect(doc).toContain('- **executeCypher** —');
  });

  it('omits the section without a tool surface (legacy fixtures unaffected)', () => {
    expect(renderCapabilitiesDoc(FIXTURE)).not.toContain('## Assistant tool surface');
  });
});
