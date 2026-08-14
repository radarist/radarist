import { buildPreludeBlock, injectIntoPrompt } from '../stitch';
import type { SubMissionResult } from '../run-sub-mission';

const ok = (skill: string, target: string | undefined, body: string): SubMissionResult => ({
  skill,
  target,
  block: body,
  costUsd: 0.05,
  durationMs: 5_000,
  firedAt: '2026-04-29T00:00:00.000Z',
  success: true,
});

describe('buildPreludeBlock', () => {
  it('returns empty string when there are no successful results', () => {
    expect(buildPreludeBlock([])).toBe('');
    expect(
      buildPreludeBlock([{ ...ok('jtbd-framing', 'Workday', '<jtbd>...</jtbd>'), success: false, block: '' }])
    ).toBe('');
  });

  it('emits the PRECOMPUTED DISCIPLINE header followed by blocks', () => {
    const block = buildPreludeBlock([ok('jtbd-framing', 'Workday', '<jtbd technology="Workday">Job: ...</jtbd>')]);
    expect(block).toContain('PRECOMPUTED DISCIPLINE');
    expect(block).toContain('<jtbd technology="Workday">Job: ...</jtbd>');
  });

  it('groups per-entity blocks before brief-level blocks', () => {
    const results = [
      ok('cynefin-classification', undefined, '<cynefin>Domain: Complicated</cynefin>'),
      ok('jtbd-framing', 'Workday', '<jtbd technology="Workday">Job: A</jtbd>'),
      ok('three-horizons', undefined, '<three-horizons>...</three-horizons>'),
      ok('jtbd-framing', 'Eightfold', '<jtbd technology="Eightfold">Job: B</jtbd>'),
    ];
    const block = buildPreludeBlock(results);
    const idxJtbd = block.indexOf('<jtbd technology="Workday">');
    const idxCynefin = block.indexOf('<cynefin>');
    expect(idxJtbd).toBeGreaterThan(0);
    expect(idxCynefin).toBeGreaterThan(idxJtbd);
  });

  it('skips failed sub-missions', () => {
    const results = [
      ok('jtbd-framing', 'Workday', '<jtbd>good</jtbd>'),
      { ...ok('jtbd-framing', 'Eightfold', ''), success: false, error: 'timeout' },
    ];
    const block = buildPreludeBlock(results);
    expect(block).toContain('<jtbd>good</jtbd>');
    expect(block.match(/<jtbd/g)).toHaveLength(1);
  });
});

describe('injectIntoPrompt', () => {
  it('prepends the prelude block before the original prompt', () => {
    const original = 'ROLE: creator\nDIRECTIVE: do the thing.';
    const injected = injectIntoPrompt('PRECOMPUTED DISCIPLINE\n<jtbd>X</jtbd>\n', original);
    expect(injected.startsWith('PRECOMPUTED DISCIPLINE')).toBe(true);
    expect(injected.endsWith(original)).toBe(true);
  });

  it('returns the original prompt unchanged when prelude is empty', () => {
    const original = 'ROLE: creator\nDIRECTIVE: do the thing.';
    expect(injectIntoPrompt('', original)).toBe(original);
  });
});
