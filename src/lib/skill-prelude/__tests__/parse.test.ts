import { parseCriticalDimensions } from '../parse';

const PROMPT_WITH_DIMENSIONS = `ROLE: creator
AUDIENCE: CHRO at 5000-person logistics firm
DECISION CONTEXT: Q3 2026 vendor pilot
SCOPE: Workday Skills Cloud, Eightfold AI, Gloat, LinkedIn Talent Insights
DEPTH: full
REPORT TYPE: IMRAD

DIRECTIVE:
Compare AI-in-HR vendors for skills-based talent mobility.

CRITICAL DIMENSIONS (invoke matching skills; critique-report fails on missing applicable dimensions):
- JTBD framing per technology: required — vendors compete on different jobs
- Wardley evolution-stage per technology: required — maturity claims need stage anchor
- NASA TRL per technology: required — Q3 2026 pilot decision needs production-readiness gating
- Three Horizons tag per recommendation: N/A — single-horizon brief
- Cynefin domain classification at brief opening: required — emerging-tech selection
- Cheapest experiment per recommendation: required — pilot is the cheapest test
- Claim provenance brackets ([validated, <source>] or [assumption, retire-by <milestone>]) on quantitative claims: required
`;

const PROMPT_WITHOUT_DIMENSIONS = 'Analyze the talent intelligence space and write a one-pager.';

const LIVE_COMPACT_DIMENSIONS = `ROLE: creator
AUDIENCE: Release owner
DECISION CONTEXT: Determine whether assistant orchestration is release-ready.
SCOPE: Company Alpha, Technology Beta, Strategy Gamma

DIRECTIVE:
Compare the records and report on graph consistency.

CRITICAL DIMENSIONS:
- JTBD framing per technology: N/A — this is an integrity audit
- Wardley evolution-stage per technology: N/A — maturity is out of scope
- NASA TRL per technology: N/A — readiness is out of scope
- Three Horizons tag per recommendation: N/A — no portfolio roadmap
- Cynefin domain classification at brief opening: N/A — no decision-domain analysis
- Cheapest experiment per recommendation: N/A — no experiment design
- Claim provenance brackets ([validated, <source>] or [assumption, retire-by <milestone>]) on quantitative claims: required
`;

describe('parseCriticalDimensions', () => {
  it('returns null when no CRITICAL DIMENSIONS block is present', () => {
    expect(parseCriticalDimensions(PROMPT_WITHOUT_DIMENSIONS)).toBeNull();
  });

  it('extracts only "required" entries, skipping N/A', () => {
    const parsed = parseCriticalDimensions(PROMPT_WITH_DIMENSIONS);
    expect(parsed).not.toBeNull();
    expect(parsed!.skills).toEqual(
      new Set([
        'jtbd-framing',
        'evolution-stage',
        'score-technology-readiness',
        'cynefin-classification',
        'cheapest-experiment',
        'claim-provenance',
      ])
    );
    expect(parsed!.skills.has('three-horizons')).toBe(false);
    expect(parsed!.notApplicableSkills).toEqual(new Set(['three-horizons']));
  });

  it('accepts the compact live header and retains required and N/A skills separately', () => {
    const parsed = parseCriticalDimensions(LIVE_COMPACT_DIMENSIONS);

    expect(parsed).not.toBeNull();
    expect(parsed!.skills).toEqual(new Set(['claim-provenance']));
    expect(parsed!.notApplicableSkills).toEqual(
      new Set([
        'jtbd-framing',
        'evolution-stage',
        'score-technology-readiness',
        'three-horizons',
        'cynefin-classification',
        'cheapest-experiment',
      ])
    );
  });

  it('rejects prose lookalikes instead of activating a skill block', () => {
    const prose = `The report should discuss CRITICAL DIMENSIONS:
- JTBD framing per technology: required
`;

    expect(parseCriticalDimensions(prose)).toBeNull();
  });

  it('lets required win when a malformed block repeats a skill as N/A', () => {
    const conflicting = `CRITICAL DIMENSIONS:
- JTBD framing per technology: required
- JTBD framing per technology: N/A — contradictory duplicate
`;
    const parsed = parseCriticalDimensions(conflicting);

    expect(parsed!.skills).toEqual(new Set(['jtbd-framing']));
    expect(parsed!.notApplicableSkills).toEqual(new Set());
  });

  it('ignores unknown directive prefixes', () => {
    const odd = `${PROMPT_WITH_DIMENSIONS.replace('Cheapest experiment per recommendation', 'Some unknown directive')}`;
    const parsed = parseCriticalDimensions(odd);
    expect(parsed!.skills.has('cheapest-experiment')).toBe(false);
  });

  it('treats whitespace-loose lines correctly', () => {
    const loose = `CRITICAL DIMENSIONS (invoke matching skills):
-   JTBD framing per technology:   required — note
-Wardley evolution-stage per technology:required
- Three Horizons tag per recommendation: required
`;
    const parsed = parseCriticalDimensions(loose);
    expect(parsed!.skills.has('jtbd-framing')).toBe(true);
    expect(parsed!.skills.has('evolution-stage')).toBe(true);
    expect(parsed!.skills.has('three-horizons')).toBe(true);
  });
});
