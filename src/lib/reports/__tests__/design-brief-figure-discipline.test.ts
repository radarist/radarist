/**
 * COORD-011, 2026-08-06 — the figure/label discipline rules must reach the author.
 *
 * Four independent blind reviewers scored the best artifact this pipeline had
 * produced and all four answered NO to "board-ready without apology". Every rule
 * asserted below corresponds to a defect they corroborated on a real published
 * report. They live in the rich-executive (free-hand) block, so this test is the
 * guard against them being trimmed back out as prompt bloat: each one was paid
 * for with a measured failure.
 */
import { buildDesignBriefPromptBlock } from '@/lib/reports/design-brief-instruction';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';

const richExecutive = buildDesignBriefPromptBlock({
  ...resolveDesignBrief('u'),
  visualAmbition: 'rich-executive',
});

describe('rich-executive briefs carry the measured figure/label discipline', () => {
  it.each([
    // 4/4 judges named this the single first defect a designer would fix.
    ['value label never on the fill it labels', /never set a value label on the fill it labels/i],
    ['reserve room for the widest value', /widest value in the series/i],
    // Radar/scatter collisions, cited by every judge.
    ['no label may touch a mark', /no label may touch, cross or sit on any mark/i],
    ['no half-empty chart canvas', /do not draw an empty canvas/i],
    ['figure ground matches its card', /figure ground must match the surface/i],
    // A stranded citation outside its own callout box.
    ['callout citations sit inside the callout', /citation belonging to a callout, sits inside its box/i],
    // The generated infographic was judged a liability, not an asset.
    ['generated images must carry data', /generated image must carry data/i],
    ['prefer inline SVG over a decorative image', /author inline SVG instead of generating one/i],
    // 2/4 judges made this their first fix: "[3]" rows whose value is a lone ".".
    ['phone restack keeps complete cell content', /COMPLETE content including its citation/i],
    ['broken restack is called out by shape', /label is `\[3\]` and whose value is a lone `\.` or `\?`/i],
    // The instruction originally targeted MARKUP; a real run complied at the
    // markup level and still shipped the defect, because the cause is CSS.
    ['names the CSS cause, not just the symptom', /promotes EVERY inline child to a track item/i],
    ['shows a working restack pattern', /td\{display:block\} td::before\{content:attr\(data-label\);display:block\}/i],
    // The empty right third at 1440.
    ['one measure system', /hold one measure system/i],
    // Typography/finish details that were individually small and jointly costly.
    ['caption alignment consistent', /caption alignment consistent/i],
    ['chips spaced from following text', /inline chips/i],
    ['limitations in the reader language', /language of the system that produced/i],
  ])('states the rule: %s', (_label, pattern) => {
    expect(richExecutive).toMatch(pattern);
  });

  it('keeps the rules out of the constrained (non-rich) block', () => {
    const constrained = buildDesignBriefPromptBlock(resolveDesignBrief('u'));
    // The default brief is not rich-executive, so it takes the other branch and
    // must not inherit free-hand authoring guidance.
    expect(constrained).not.toMatch(/never set a value label on the fill it labels/i);
  });
});
