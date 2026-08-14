jest.mock('@/lib/ai/capability-catalog.generated', () => ({
  CAPABILITY_CATALOG: {
    skills: [
      {
        name: 'apply-hype-cycle',
        description: 'Where a technology sits in its maturity arc',
        category: 'Analysis & forecasting',
      },
      {
        name: 'assess-research-momentum',
        description: 'Is a research area accelerating',
        category: 'Analysis & forecasting',
      },
    ],
    profiles: [],
    tools: [],
  },
}));

import { getSlashCommands, filterSlashCommands } from '../slash-commands';

describe('getSlashCommands', () => {
  it('always includes the built-in commands', () => {
    const ids = getSlashCommands().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['capabilities', 'research', 'diagram', 'build', 'limitless']));
  });

  it('includes /build as a builtin that seeds the solution-build brief template (BUILD-024)', () => {
    const build = getSlashCommands().find((c) => c.id === 'build');
    expect(build).toBeTruthy();
    expect(build!.label).toBe('/build');
    expect(build!.capability).toBeUndefined(); // builtin, not a catalog skill
    expect(build!.preset).toBeUndefined();
    expect(build!.template).toContain('sandboxed build mission');
    expect(build!.template).toContain('Done means');
    expect(build!.template).toContain('confirm');
    expect(build!.template.trimEnd()).toMatch(/of:$/); // user completes with the ask
  });

  it('includes /limitless as a builtin that seeds the premium-tier template (BUILD-023/024)', () => {
    const limitless = getSlashCommands().find((c) => c.id === 'limitless');
    expect(limitless).toBeTruthy();
    expect(limitless!.label).toBe('/limitless');
    expect(limitless!.capability).toBeUndefined(); // builtin, not a catalog skill
    expect(limitless!.preset).toBeUndefined();
    expect(limitless!.template).toContain('Limitless premium tier');
    expect(limitless!.template).toContain('confirm');
    // single-session /goal build tier (redefined) — the user completes the ask after "of:"
    expect(limitless!.template.trimEnd()).toMatch(/of:$/);
  });

  it('/limitless template tells the assistant to draft a goal + design brief and confirm the $50 first', () => {
    const cmd = getSlashCommands().find((c) => c.id === 'limitless')!;
    expect(cmd.template).toMatch(/draft/i);
    expect(cmd.template).toMatch(/design brief/i);
    expect(cmd.template).toMatch(/\$50|confirm/i);
  });

  it('appends catalog skills as /skill-name commands with their description', () => {
    const cmds = getSlashCommands();
    const hype = cmds.find((c) => c.id === 'apply-hype-cycle');
    expect(hype).toBeTruthy();
    expect(hype!.label).toBe('/apply-hype-cycle');
    expect(hype!.capability).toBe('apply-hype-cycle');
    expect(hype!.template.length).toBeGreaterThan(0);
    expect(hype!.description).toContain('maturity arc');
  });

  it('puts built-ins before catalog skills', () => {
    const cmds = getSlashCommands();
    const firstSkillIdx = cmds.findIndex((c) => c.capability);
    const lastBuiltinIdx = cmds.map((c) => !!c.capability).lastIndexOf(false);
    expect(lastBuiltinIdx).toBeLessThan(firstSkillIdx);
  });

  it('includes mission-preset commands (e.g. /patent-landscape) with a preset id + seed template', () => {
    const cmds = getSlashCommands();
    const preset = cmds.find((c) => c.id === 'patent-landscape');
    expect(preset).toBeTruthy();
    expect(preset!.label).toBe('/patent-landscape');
    expect(preset!.preset).toBe('patent-landscape');
    expect(preset!.capability).toBeUndefined();
    // the template is the full canned brief the user completes with a subject
    expect(preset!.template).toContain('searchPatents');
    expect(preset!.template.trimEnd()).toMatch(/SUBJECT:$/);
  });
});

describe('filterSlashCommands', () => {
  it('empty query returns everything', () => {
    expect(filterSlashCommands('').length).toBe(getSlashCommands().length);
  });

  it('filters case-insensitively by id (prefix + substring)', () => {
    const ids = filterSlashCommands('res').map((c) => c.id);
    expect(ids).toContain('research');
    expect(ids).toContain('assess-research-momentum'); // substring of id
  });

  it('also matches on description text', () => {
    const ids = filterSlashCommands('maturity').map((c) => c.id);
    expect(ids).toContain('apply-hype-cycle');
  });

  it('returns [] for a query that matches nothing', () => {
    expect(filterSlashCommands('zzzznomatch')).toEqual([]);
  });
});
