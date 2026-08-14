/**
 * @jest-environment node
 */
jest.mock('@/lib/ai/capability-catalog.generated', () => ({
  CAPABILITY_CATALOG: {
    skills: [
      {
        name: 'apply-hype-cycle',
        description: 'Where a technology sits in its maturity arc',
        category: 'Analysis & forecasting',
      },
      {
        name: 'research-technology',
        description: 'Technology deep research procedure',
        category: 'Research & evidence',
      },
      {
        name: 'oss-project-health',
        description: 'CHAOSS-style vitality read of a repo',
        category: 'Research & evidence',
      },
    ],
    profiles: [
      { name: 'scout', role: 'Discovers new signals and technologies' },
      { name: 'creator', role: 'Produces reports and infographics' },
      { name: 'evaluator', role: 'Evidence-first hands-on evaluation of technologies' },
      // catalog-listed but NOT user-dispatchable (verification pipeline only)
      { name: 'defense-minister', role: 'Adversarial verification of claims and evidence' },
    ],
    tools: [{ name: 'searchOssHealth', summary: 'Look up OSS repo health metrics' }],
    features: [
      {
        name: 'build-missions',
        summary: 'Sandboxed autonomous prototyping producing app/evaluation artifacts',
        status: 'flag-gated (IMPULSE_BUILD_ENABLED, default off)',
      },
      {
        name: 'limitless-build-mode',
        summary: 'Premium per-mission build tier with Opus models and raised bounded budget',
        status: 'flag-gated (requires build missions on; opt-in per mission)',
      },
    ],
  },
}));

import { executeListCapabilities, executeDescribeCapability, CAPABILITY_TOOLS } from '../capability-tools';

describe('CAPABILITY_TOOLS declarations', () => {
  it('declares listCapabilities and describeCapability', () => {
    expect(CAPABILITY_TOOLS.map((t) => t.name).sort()).toEqual(['describeCapability', 'listCapabilities']);
  });
});

describe('executeListCapabilities', () => {
  it('with no query returns a grouped overview with totals', () => {
    const r = executeListCapabilities({});
    expect(r.success).toBe(true);
    const data = r.data as {
      categories: Array<{ category: string; count: number; skills: string[] }>;
      features: Array<{ name: string; status: string }>;
      totals: { skills: number; features: number };
    };
    expect(data.totals.skills).toBe(3);
    const research = data.categories.find((c) => c.category === 'Research & evidence')!;
    expect(research.count).toBe(2);
    expect(research.skills).toEqual(['oss-project-health', 'research-technology']); // sorted
    // Platform features surface in the overview with their honest status
    expect(data.totals.features).toBe(2);
    expect(data.features.map((f) => f.name)).toContain('build-missions');
  });

  it('with a query filters skills/profiles/tools and suggests a profile + hint', () => {
    const r = executeListCapabilities({ query: 'health' });
    expect(r.success).toBe(true);
    const data = r.data as {
      matches: { skills: Array<{ name: string }>; tools: Array<{ name: string }> };
      suggestedProfile: string;
      hint: string;
    };
    expect(data.matches.skills.map((s) => s.name)).toContain('oss-project-health');
    expect(data.matches.tools.map((t) => t.name)).toContain('searchOssHealth');
    expect(data.suggestedProfile).toBeTruthy();
    expect(data.hint).toContain('mission');
  });

  it('suggests the creator profile for report-shaped queries', () => {
    const r = executeListCapabilities({ query: 'write a report' });
    expect((r.data as { suggestedProfile: string }).suggestedProfile).toBe('creator');
  });

  it('never suggests the undispatchable defense-minister profile — verification queries route to evaluator (DISC-002)', () => {
    for (const query of ['verify this claim', 'fact check the evidence', 'defensive validation']) {
      const r = executeListCapabilities({ query });
      const suggested = (r.data as { suggestedProfile: string }).suggestedProfile;
      expect(suggested).not.toBe('defense-minister'); // startMission would throw on it
      expect(suggested).toBe('evaluator');
    }
  });

  it('with a query matches platform features by name/summary', () => {
    const r = executeListCapabilities({ query: 'prototyping' });
    expect(r.success).toBe(true);
    const data = r.data as { matches: { features: Array<{ name: string }> } };
    expect(data.matches.features.map((f) => f.name)).toContain('build-missions');
  });
});

describe('executeDescribeCapability', () => {
  it('finds a skill by normalized name', () => {
    const r = executeDescribeCapability({ name: 'Apply Hype Cycle' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ kind: 'skill', name: 'apply-hype-cycle' });
  });

  it('finds a profile', () => {
    const r = executeDescribeCapability({ name: 'scout' });
    expect(r.data).toMatchObject({ kind: 'profile', name: 'scout', role: 'Discovers new signals and technologies' });
  });

  it('returns found:false with near matches for an unknown name (not an error)', () => {
    const r = executeDescribeCapability({ name: 'hype' });
    expect(r.success).toBe(true);
    const data = r.data as { found: boolean; nearMatches: string[] };
    expect(data.found).toBe(false);
    expect(data.nearMatches).toContain('apply-hype-cycle');
  });

  it('finds a platform feature and returns its honest status', () => {
    const r = executeDescribeCapability({ name: 'limitless-build-mode' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({
      kind: 'feature',
      name: 'limitless-build-mode',
      status: 'flag-gated (requires build missions on; opt-in per mission)',
    });
  });

  it('includes feature names in near matches for unknown queries', () => {
    const r = executeDescribeCapability({ name: 'build' });
    const data = r.data as { found: boolean; nearMatches: string[] };
    expect(data.found).toBe(false);
    expect(data.nearMatches).toEqual(expect.arrayContaining(['build-missions']));
  });

  it('trims surrounding whitespace before normalizing, so a space-padded name still resolves', () => {
    const r = executeDescribeCapability({ name: '  Apply Hype Cycle  ' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ kind: 'skill', name: 'apply-hype-cycle' });
    expect((r.data as { found?: boolean }).found).not.toBe(false);
  });
});
