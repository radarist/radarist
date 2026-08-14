import { REPORT_GUTTER_LADDER, REPORT_PROSE_MEASURE, expectedReportGutterPx } from '../presentation-contract';

describe('report presentation contract (COORD-017)', () => {
  it('pins the evidence-calibrated prose measure band', () => {
    // 60–90: the identity-verified COORD-011 winner runs 85–87 characters at
    // tablet/desktop and was blessed by four blind reviewers; RC.2's rejected
    // baseline ran 178. The ceiling is a hard capture failure, the floor is
    // the authoring target.
    expect(REPORT_PROSE_MEASURE).toEqual({ targetMinChars: 60, maxChars: 90 });
  });

  it('pins the gutter ladder the authoring instruction and capture gate share', () => {
    expect(REPORT_GUTTER_LADDER).toEqual([
      { minViewportPx: 1200, minGutterPx: 48 },
      { minViewportPx: 720, minGutterPx: 22 },
      { minViewportPx: 0, minGutterPx: 16 },
    ]);
  });

  it.each([
    [390, 16],
    [719, 16],
    [720, 22],
    [768, 22],
    [1199, 22],
    [1200, 48],
    [1440, 48],
  ])('resolves the gutter minimum for a %dpx viewport as %dpx', (viewport, gutter) => {
    expect(expectedReportGutterPx(viewport)).toBe(gutter);
  });
});
