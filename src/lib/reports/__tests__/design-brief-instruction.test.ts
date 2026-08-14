/**
 * REPORT-015 — the report-authoring model receives its DesignBrief.
 *
 * The row's acceptance rests on one guarantee: no analyzer check may be armed
 * that the brief does not make satisfiable. These tests prove the chain end to
 * end — the brief's values reach the prompt, HTML written to that prompt passes
 * the EXISTING analyzer, and each armed check names a value the prompt supplies.
 */
import {
  analyzeCreatorBrand,
  BRAND_CLASS_NAMES,
  BRAND_VARIABLES,
} from '@/lib/mission-quality/analyzers/creator-brand-analyzer';
import { BRAND_STYLESHEET_LINK, buildDesignBriefPromptBlock } from '@/lib/reports/design-brief-instruction';
import { resolveDesignBrief, type DesignBrief } from '@/lib/schemas/design-brief';

const brandDarkBrief = resolveDesignBrief('u');
const userLightBrief: DesignBrief = resolveDesignBrief('u', {
  theme: 'brand-light',
  source: 'user',
});

describe('the resolved brief reaches the authoring prompt', () => {
  const block = buildDesignBriefPromptBlock(brandDarkBrief);

  it('renders the exact palette hexes, not a description of them', () => {
    for (const hex of [
      brandDarkBrief.palette.bg,
      brandDarkBrief.palette.surface,
      brandDarkBrief.palette.ink,
      brandDarkBrief.palette.accent,
      ...brandDarkBrief.palette.sequence,
    ]) {
      expect(block).toContain(hex);
    }
  });

  it('renders the theme and both typography faces', () => {
    expect(block).toContain(brandDarkBrief.theme);
    expect(block).toContain(brandDarkBrief.typography.display);
    expect(block).toContain(brandDarkBrief.typography.body);
    expect(block).toContain('Visual ambition: standard');
  });

  it('turns rich-executive ambition into evidence-bound, responsive guidance', () => {
    const rich = buildDesignBriefPromptBlock({ ...brandDarkBrief, visualAmbition: 'rich-executive' });
    expect(rich).toContain('you own it');
    expect(rich).toContain(BRAND_STYLESHEET_LINK);
    expect(rich).toContain('at least three distinct');
    expect(rich).toContain('at least two non-tabular');
    expect(rich).toContain('stack comparison tables');
    expect(rich).toContain('visible swipe cue');
    expect(rich).toContain('print/A4 rules');
    expect(rich).toContain('never print a');
    expect(rich).toContain('no JavaScript');
  });

  it('keeps the server authoritative — it tells the writer the palette is applied for it', () => {
    expect(block).toMatch(/server appends/i);
  });

  it('emits nothing without a brief, so brief-less missions are unchanged', () => {
    expect(buildDesignBriefPromptBlock(undefined)).toBe('');
  });
});

describe('every ARMED analyzer check names a value the prompt supplies', () => {
  // The two checks REPORT-015 arms in report-tools.ts. If a check is added to
  // that armed list without the instruction supplying its value, this fails.
  const block = buildDesignBriefPromptBlock(brandDarkBrief);

  it('brand-stylesheet-linked: the prompt contains the exact link the check looks for', () => {
    expect(block).toContain(BRAND_STYLESHEET_LINK);
    // ...and that literal string genuinely satisfies the analyzer.
    const html = `<!doctype html><html><head><title>t</title>${BRAND_STYLESHEET_LINK}</head><body><p>x</p></body></html>`;
    const verdict = analyzeCreatorBrand(html, brandDarkBrief);
    const checks = verdict.ok ? [] : verdict.violations.map((v) => v.check);
    expect(checks).not.toContain('brand-stylesheet-linked');
  });

  it('no-variable-shadowing: the prompt lists every variable the check guards', () => {
    for (const variable of BRAND_VARIABLES) {
      expect(block).toContain(variable);
    }
  });
});

/**
 * REPORT-015 residual — the instruction told the writer to "reach for the brand
 * component classes" without ever listing them.
 *
 * A rule the writer cannot see is not satisfiable. The check stays recorded-only
 * precisely because a class count is not
 * deterministically satisfiable — so the only honest lever is to hand the writer
 * the vocabulary and the number, from the checker's own constants.
 */
describe('the instruction supplies the vocabulary the class-budget check measures', () => {
  const block = buildDesignBriefPromptBlock(brandDarkBrief);

  it('lists brand component classes the writer can reach for', () => {
    // Not the whole set — the component vocabulary an author actually composes
    // with. Every name listed must be one the checker recognises.
    const listed = Array.from(block.matchAll(/`\.([a-z][\w-]*)`/g), (m) => m[1]);
    expect(listed.length).toBeGreaterThanOrEqual(20);
    for (const name of listed) {
      expect(BRAND_CLASS_NAMES.has(name)).toBe(true);
    }
  });

  it('states that brand uptake is telemetry rather than a fixed class budget', () => {
    expect(block).toContain('Brand-class uptake is recorded as telemetry');
    expect(block).toContain('no fixed custom-class warning or budget');
  });

  it('emits nothing extra for a brief-less mission', () => {
    expect(buildDesignBriefPromptBlock(undefined)).toBe('');
  });
});

describe('HTML written to this instruction passes the existing analyzer', () => {
  /** What an author following the block would produce. */
  const conformingReport = `<!doctype html><html><head><title>Report</title>
${BRAND_STYLESHEET_LINK}
<style>
  .workload-grid { display: grid; gap: 16px; }
  .workload-grid h2 { color: var(--text-primary); background: var(--bg-card); }
</style></head>
<body><h1 style="color: var(--text-primary)">Findings</h1>
<p>Body copy<a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a></p>
<ol><li id="ref-1">A. Author — <span class="ref-source">https://example.com/paper</span></li></ol>
</body></html>`;

  it('produces no violation of either armed check', () => {
    const verdict = analyzeCreatorBrand(conformingReport, brandDarkBrief);
    const checks = verdict.ok ? [] : verdict.violations.map((v) => v.check);
    expect(checks).not.toContain('brand-stylesheet-linked');
    expect(checks).not.toContain('no-variable-shadowing');
  });

  it('FAILS both armed checks for the pre-REPORT-015 shape (no link, shadowed tokens)', () => {
    // The measured failure: a writer with no brief invents its own system.
    const inventedSystem = `<!doctype html><html><head><title>Report</title></head>
<body><style>:root { --text-primary: #fff; --accent-gold: #ff0; }</style><p>x</p></body></html>`;
    const verdict = analyzeCreatorBrand(inventedSystem, brandDarkBrief);
    const checks = verdict.ok ? [] : verdict.violations.map((v) => v.check);
    expect(checks).toContain('brand-stylesheet-linked');
    expect(checks).toContain('no-variable-shadowing');
  });
});

describe('a user-chosen light theme keeps PROFILE §0 precedence', () => {
  it('does not demand the dark brand stylesheet the analyzer itself skips', () => {
    const block = buildDesignBriefPromptBlock(userLightBrief);
    expect(block).not.toContain(BRAND_STYLESHEET_LINK);
    // The analyzer skips that check for the same case, so prompt and gate agree.
    const html = '<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>';
    const verdict = analyzeCreatorBrand(html, userLightBrief);
    const checks = verdict.ok ? [] : verdict.violations.map((v) => v.check);
    expect(checks).not.toContain('brand-stylesheet-linked');
  });

  it('still delivers the user palette hexes', () => {
    const block = buildDesignBriefPromptBlock(userLightBrief);
    expect(block).toContain(userLightBrief.palette.bg);
    expect(block).toContain(userLightBrief.palette.accent);
  });
});
