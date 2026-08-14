import { composeSolutionBrief } from '../build-mission-solution-composer';
import { resolveDesignBrief } from '../schemas/design-brief';

const base = {
  title: 'Competitor Radar',
  objective: 'Let an analyst compare 6 vendors on 4 axes at a glance.',
  mustHaves: ['Sortable vendor table', 'Radar chart', 'Vendor detail drawer'],
  designBrief: resolveDesignBrief('u1', { theme: 'brand-dark' }),
};

it('emits every required section', () => {
  const { brief } = composeSolutionBrief(base);
  for (const h of [
    '# Mission',
    '## Objective',
    '## Must-have features',
    '## Out of scope',
    '## Done means',
    '## Design Brief',
    '## Acceptance Rubric',
  ]) {
    expect(brief).toContain(h);
  }
});
it('renders the palette hexes + typography into the Design Brief so the sandbox can consume them', () => {
  const { brief } = composeSolutionBrief(base);
  expect(brief).toContain(base.designBrief.palette.accent);
  expect(brief).toContain(base.designBrief.typography.display);
});
it('the Acceptance Rubric names the machine gates (checks + QA + design tokens/contrast)', () => {
  const { brief } = composeSolutionBrief(base);
  expect(brief).toMatch(/builder is ready for the independent reviewer/i);
  expect(brief).not.toMatch(/\/goal loop/i);
  expect(brief).toMatch(/\.impulse\/checks\.json/);
  expect(brief).toMatch(/qa-report\.json/);
  expect(brief).toMatch(/no hardcoded hex|design tokens/i);
  expect(brief).toMatch(/contrast/i);
});
it('forbids placeholder content (no lorem/foo/bar) in the Design Brief instructions', () => {
  const { brief } = composeSolutionBrief(base);
  expect(brief).toMatch(/real.*content|no lorem|no foo\/bar/i);
});
