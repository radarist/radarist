/**
 * @file lib/__tests__/creator-brand-analyzer.test.ts
 * @description Regression tests for the brand-compliance analyzer.
 *
 * The fixtures cover each of the four checks plus the all-pass case. Every
 * banned-class pattern from the May 6–8 audit is included so a future
 * unconscious revival of those patterns trips the gate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeCreatorBrand,
  isHtmlReport,
  findOffPaletteFills,
  BRAND_CLASS_NAMES,
} from '../mission-quality/analyzers/creator-brand-analyzer';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';
import { markSuperGraphSvg } from '@/lib/super-graph/provenance';

describe('isHtmlReport', () => {
  it('returns false for empty result', () => {
    expect(isHtmlReport('')).toBe(false);
  });

  it('returns false for short markdown brief', () => {
    expect(isHtmlReport('# Brief\n\nShort SBAR brief, no HTML.')).toBe(false);
  });

  it('returns true when result has <html>', () => {
    expect(isHtmlReport('<!DOCTYPE html><html><body>...</body></html>'.padEnd(250, ' '))).toBe(true);
  });

  it('returns true when result has <body> only', () => {
    expect(isHtmlReport('<body>'.padEnd(250, ' ') + 'long enough')).toBe(true);
  });
});

describe('analyzeCreatorBrand — all checks pass on a brand-compliant report', () => {
  const compliant = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Test Report</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <link rel="stylesheet" href="/css/report-brand.css" />
      <style>
        /* page-specific overrides only — no brand variable shadowing */
        .my-page-class { padding: 1rem; }
      </style>
    </head>
    <body>
      <header class="report-header">
        <div class="container">
          <div class="header-label">Strategic Brief</div>
          <h1 class="report-title">A Compliant Report</h1>
        </div>
      </header>
      <section class="section">
        <div class="container">
          <div class="section-label">01 · Section</div>
          <h2 class="section-title">First Section</h2>
          <div class="section-divider"></div>
          <p>Some claim with a citation<sup class="cite">[1]</sup>.</p>
          <div class="stats-grid">
            <div class="stat-card"><div class="stat-number">42</div></div>
          </div>
          <table class="compare-table"><tr><td>x</td></tr></table>
          <div class="action-card">A play.</div>
        </div>
      </section>
    </body>
    </html>
  `;

  it('returns ok for a compliant report', () => {
    const verdict = analyzeCreatorBrand(compliant);
    expect(verdict.ok).toBe(true);
    expect(verdict.htmlLength).toBe(compliant.length);
  });
});

describe('analyzeCreatorBrand — check 1: brand-stylesheet-linked', () => {
  it('flags a report missing the brand stylesheet link', () => {
    const html = `<head><title>x</title></head><body><sup class="cite">[1]</sup></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.violations.map((v) => v.check)).toContain('brand-stylesheet-linked');
  });

  it('accepts the link when href uses double quotes', () => {
    const html = `<head><link rel="stylesheet" href="/css/report-brand.css" /></head><body></body>`;
    const verdict = analyzeCreatorBrand(html);
    if (!verdict.ok) {
      expect(verdict.violations.find((v) => v.check === 'brand-stylesheet-linked')).toBeUndefined();
    }
  });

  it('accepts the link when href uses single quotes', () => {
    const html = `<head><link rel='stylesheet' href='/css/report-brand.css' /></head><body></body>`;
    const verdict = analyzeCreatorBrand(html);
    if (!verdict.ok) {
      expect(verdict.violations.find((v) => v.check === 'brand-stylesheet-linked')).toBeUndefined();
    }
  });

  it('rejects a different stylesheet at a similar path', () => {
    const html = `<head><link rel="stylesheet" href="/css/page-brand.css" /></head><body></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.violations.map((v) => v.check)).toContain('brand-stylesheet-linked');
  });
});

describe('analyzeCreatorBrand — check 2: no-variable-shadowing', () => {
  it('flags a report that redeclares a brand variable', () => {
    const html = `
      <head>
        <link rel="stylesheet" href="/css/report-brand.css" />
        <style>
          :root {
            --bg-primary: #ffffff;
            --accent-gold: #6366f1;
          }
        </style>
      </head>
      <body></body>
    `;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    const shadow = verdict.violations.find((v) => v.check === 'no-variable-shadowing');
    expect(shadow).toBeDefined();
    expect(shadow!.detail).toContain('--bg-primary');
    expect(shadow!.detail).toContain('--accent-gold');
  });

  it('does not flag var() usage of brand variables', () => {
    const html = `
      <head>
        <link rel="stylesheet" href="/css/report-brand.css" />
        <style>
          .my-class { color: var(--accent-gold); background: var(--bg-card); }
        </style>
      </head>
      <body></body>
    `;
    const verdict = analyzeCreatorBrand(html);
    if (!verdict.ok) {
      expect(verdict.violations.find((v) => v.check === 'no-variable-shadowing')).toBeUndefined();
    }
  });

  it('flags --gradient-gold redeclarations', () => {
    const html = `
      <head>
        <link rel="stylesheet" href="/css/report-brand.css" />
        <style>:root { --gradient-gold: linear-gradient(0deg, #fff, #000); }</style>
      </head>
      <body></body>
    `;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.violations.find((v) => v.check === 'no-variable-shadowing')!.detail).toContain('--gradient-gold');
  });
});

describe('analyzeCreatorBrand — check 3: citations-use-cite-class', () => {
  const baseHead = `<head><link rel="stylesheet" href="/css/report-brand.css" /></head>`;

  it('flags a citation <sup> without class="cite"', () => {
    const html = `${baseHead}<body><p>Some claim<sup>[1]</sup>.</p></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.violations.map((v) => v.check)).toContain('citations-use-cite-class');
  });

  it('accepts <sup class="cite">[1]</sup>', () => {
    const html = `${baseHead}<body><p>Claim<sup class="cite">[1]</sup>.</p></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(true);
  });

  it('does not flag non-citation <sup> like footnote symbols', () => {
    // <sup>†</sup> is not a citation (no [N] format), so it's exempt.
    const html = `${baseHead}<body><p>Note<sup>†</sup>.</p></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(true);
  });

  it('handles compound citations like [1, 2, 3]', () => {
    const html = `${baseHead}<body><p>Claim<sup>[1, 2, 3]</sup>.</p></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.violations.map((v) => v.check)).toContain('citations-use-cite-class');
  });

  it('reports the count when many citations are missing the class', () => {
    const html = `${baseHead}<body>
      <sup>[1]</sup><sup>[2]</sup><sup>[3]</sup><sup>[4]</sup><sup>[5]</sup>
    </body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    const v = verdict.violations.find((x) => x.check === 'citations-use-cite-class')!;
    expect(v.detail).toContain('5 citation');
    expect(v.detail).toContain('+2 more');
  });
});

describe('analyzeCreatorBrand — check 4: no-banned-class-patterns', () => {
  const baseHead = `<head><link rel="stylesheet" href="/css/report-brand.css" /></head>`;

  // Spot check: each banned pattern from the May 6–8 audit should trip.
  const BANNED_FIXTURES: Array<[string, string]> = [
    ['rec-card', '<div class="rec-card">x</div>'],
    ['profile-card', '<div class="profile-card">x</div>'],
    ['hero-badge', '<span class="hero-badge">x</span>'],
    ['hero-tag', '<span class="hero-tag">x</span>'],
    ['tag-adopt', '<span class="tag tag-adopt">Adopt</span>'],
    ['evolution-pill', '<span class="evolution-pill ev-product">x</span>'],
    ['ev-custom', '<span class="evolution-pill ev-custom">x</span>'],
    ['experiment-box', '<div class="experiment-box">x</div>'],
    ['confidence-tag', '<span class="confidence-tag">x</span>'],
    ['audience-tag', '<span class="audience-tag">x</span>'],
    ['jtbd-card', '<div class="jtbd-card">x</div>'],
    ['stat-grid', '<div class="stat-grid">x</div>'],
    ['refs-list', '<ul class="refs-list">x</ul>'],
    ['data-table', '<table class="data-table">x</table>'],
  ];

  it.each(BANNED_FIXTURES)('flags class=%s', (banned, snippet) => {
    const html = `${baseHead}<body>${snippet}</body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    const v = verdict.violations.find((x) => x.check === 'no-banned-class-patterns');
    expect(v).toBeDefined();
    expect(v!.detail).toContain(banned);
  });

  it('accepts brand vocabulary that contains substrings of banned names', () => {
    // .stats-grid is brand (note the trailing s); .ref-num is brand;
    // .references-list is brand. None should trip even though they share
    // substrings with the banned patterns.
    const html = `${baseHead}<body>
      <div class="stats-grid"><div class="stat-card"><div class="stat-number">1</div></div></div>
      <ul class="references-list"><li><span class="ref-num">[1]</span> Source.</li></ul>
    </body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(true);
  });
});

describe('analyzeCreatorBrand — check 5 (V2): excessive-custom-classes', () => {
  const baseHead = `<head><link rel="stylesheet" href="/css/report-brand.css" /></head>`;

  it('passes when agent defines few page-specific layout classes', () => {
    // A small set of page-specific helper classes stays below the threshold.
    const html = `${baseHead}
      <style>
        .workload-grid { display: grid; grid-template-columns: repeat(3, 1fr); }
        .vendor-table-wrapper { overflow-x: auto; margin: 1rem 0; }
        .meta-row { display: flex; gap: 0.5rem; }
        .timeline-track { position: relative; padding-left: 1.5rem; }
      </style>
      <body></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(true);
  });

  it('passes when agent overrides only brand classes', () => {
    // Brand classes in agent <style> are usually overrides; they don't count
    // as inventions for this check (they would be caught separately by
    // no-variable-shadowing if they redeclare brand vars).
    const html = `${baseHead}
      <style>
        .stat-card { padding: 1rem; }
        .section-title { letter-spacing: 0.02em; }
        .compare-table { margin-top: 2rem; }
      </style>
      <body></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(true);
  });

  it('does not turn a large private vocabulary into a quality failure', () => {
    // Mirrors the dynamic-rename pattern from the first validation: even
    // when the rename names aren't on the static banned list, the *count*
    // catches the SaaS-dashboard reinvention.
    const html = `${baseHead}
      <style>
        .stage-pill { padding: 2px 9px; }
        .stage-genesis { background: #7c3aed; }
        .stage-custom { background: #0ea5e9; }
        .stage-product { background: #10b981; }
        .stage-commodity { background: #6b7280; }
        .priority-flag { font-size: 0.7em; }
        .priority-high { color: #ef4444; }
        .priority-medium { color: #f59e0b; }
        .priority-low { color: #94a3b8; }
        .vendor-block { padding: 1rem; }
      </style>
      <body></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(true);
  });

  it('does not double-count pseudo-classes', () => {
    // .foo, .foo:hover, .foo::before should count once.
    const html = `${baseHead}
      <style>
        .a { color: red; }
        .a:hover { color: blue; }
        .a::before { content: ''; }
        .b { padding: 1rem; }
        .b:focus { outline: 2px solid; }
      </style>
      <body></body>`;
    const verdict = analyzeCreatorBrand(html);
    // 2 inventions (a, b) — well under threshold.
    expect(verdict.ok).toBe(true);
  });

  it('does not use class count as a proxy for visual quality', () => {
    // None of these class names are on the BANNED_CLASSES static list, but
    // the count alone trips the heuristic — which is the whole point of
    // the V2 check.
    const html = `${baseHead}
      <style>
        .x1 { padding: 1rem; }
        .x2 { padding: 1rem; }
        .x3 { padding: 1rem; }
        .x4 { padding: 1rem; }
        .x5 { padding: 1rem; }
        .x6 { padding: 1rem; }
        .x7 { padding: 1rem; }
        .x8 { padding: 1rem; }
        .x9 { padding: 1rem; }
      </style>
      <body></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(true);
  });

  it('skips the check when there is no inline <style>', () => {
    const html = `${baseHead}<body><p>just prose, no inline style</p></body>`;
    const verdict = analyzeCreatorBrand(html);
    expect(verdict.ok).toBe(true);
  });

  it('does not charge provenance-valid Super-Graph runtime classes to the author CSS budget', () => {
    const rendererSvg = markSuperGraphSvg(`<svg xmlns="http://www.w3.org/2000/svg">
      <style>
        .cluster { fill: #fff; }
        .cluster-label { fill: #111; }
        .edge-animation-fast { animation: dash 2s linear infinite; }
        .edge-animation-slow { animation: dash 4s linear infinite; }
        .edge-pattern-dashed { stroke-dasharray: 5; }
        .edge-pattern-dotted { stroke-dasharray: 2; }
        .edge-pattern-solid { stroke-dasharray: 0; }
        .edge-thickness-0 { stroke-width: 1px; }
        .edge-thickness-1 { stroke-width: 2px; }
        .edge-thickness-2 { stroke-width: 3px; }
        .edge-thickness-3 { stroke-width: 4px; }
        .edge-thickness-4 { stroke-width: 5px; }
      </style>
      <g class="cluster"><text class="cluster-label">Trusted diagram</text></g>
    </svg>`);
    const html = `${baseHead}<style>.report-helper { display: grid; }</style><body>${rendererSvg}</body>`;

    expect(analyzeCreatorBrand(html).ok).toBe(true);
  });

  // Contract: svg-internal <style> is
  // renderer output and is structurally exempt from the agent class budget —
  // signed or not. A byte-exact provenance exemption is too fragile after
  // model re-typing, so "unsigned counts" would punish agents for using the
  // platform renderer. Page-level CSS
  // remains fully budgeted (see the trusted-diagram test below).
  it('T1.4: does NOT count unsigned svg-internal styles toward the class budget', () => {
    const html = `${baseHead}<body><svg><style>
      .edge-thickness-0 { stroke-width: 1px; }
      .edge-thickness-1 { stroke-width: 2px; }
      .edge-thickness-2 { stroke-width: 3px; }
      .edge-thickness-3 { stroke-width: 4px; }
      .edge-thickness-4 { stroke-width: 5px; }
      .edge-thickness-5 { stroke-width: 6px; }
      .edge-thickness-6 { stroke-width: 7px; }
      .edge-thickness-7 { stroke-width: 8px; }
      .edge-thickness-8 { stroke-width: 9px; }
    </style></svg></body>`;
    expect(analyzeCreatorBrand(html).ok).toBe(true);
  });

  it('T1.4: a post-render-edited signed SVG is also exempt (svg styles are renderer-owned)', () => {
    const marked = markSuperGraphSvg(`<svg><style>
      .x1 { color: red; } .x2 { color: red; } .x3 { color: red; }
      .x4 { color: red; } .x5 { color: red; } .x6 { color: red; }
      .x7 { color: red; } .x8 { color: red; } .x9 { color: red; }
    </style></svg>`);
    const tampered = marked.replace('</style>', '.x10 { color: red; }</style>');
    expect(analyzeCreatorBrand(`${baseHead}<body>${tampered}</body>`).ok).toBe(true);
  });

  it('does not charge page-authored CSS by class count', () => {
    const rendererSvg = markSuperGraphSvg('<svg><style>.cluster { fill: #fff; }</style></svg>');
    const authored = Array.from({ length: 9 }, (_, i) => `.page-${i} { padding: ${i}px; }`).join('\n');
    const verdict = analyzeCreatorBrand(`${baseHead}<style>${authored}</style><body>${rendererSvg}</body>`);

    expect(verdict.ok).toBe(true);
  });
});

describe('analyzeCreatorBrand — excessive custom-class regression fixture', () => {
  // Synthetic fixture covering the relevant shape: linked stylesheet (good)
  // plus invented .confidence-tag,
  // .audience-tag, .evolution-pill, .ev-product, .stat-grid, .jtbd-card,
  // .experiment-box, .refs-list classes (bad).
  const regression = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Graph Databases in 2026</title>
      <link rel="stylesheet" href="/css/report-brand.css" />
      <style>
        body { max-width: 960px; margin: 0 auto; }
        .confidence-tag { background: #e8f5e9; color: #2e7d32; }
        .audience-tag { background: #e3f2fd; }
        .evolution-pill { padding: 0.15rem 0.6rem; }
        .ev-product { background: #fff3e0; }
        .jtbd-card { border-left: 3px solid #6366f1; }
        .experiment-box { background: #fffde7; }
        .stat-grid { display: grid; }
        .refs-list { list-style: none; }
      </style>
    </head>
    <body>
      <div class="report-meta">
        <span class="audience-tag">CTO · CDO</span>
        <span class="section-label">Decision Brief</span>
        <span class="confidence-tag">Confidence HIGH</span>
      </div>
      <p>
        <span class="evolution-pill ev-product">Product</span>
        <sup class="cite">[1]</sup>
      </p>
      <div class="stat-grid"><div class="stat-card">x</div></div>
      <div class="experiment-box">try this</div>
      <div class="jtbd-card">job</div>
      <ul class="refs-list"><li>Source</li></ul>
    </body>
    </html>
  `;

  it('catches every category of violation present in the live regression', () => {
    const verdict = analyzeCreatorBrand(regression);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    const checks = verdict.violations.map((v) => v.check);
    // Stylesheet is linked, so check 1 should NOT fire.
    expect(checks).not.toContain('brand-stylesheet-linked');
    // No --bg-/--accent-/--text- redeclaration in this snippet → check 2 silent.
    expect(checks).not.toContain('no-variable-shadowing');
    // The single <sup> uses class="cite" → check 3 silent.
    expect(checks).not.toContain('citations-use-cite-class');
    // Banned classes are everywhere → check 4 fires.
    expect(checks).toContain('no-banned-class-patterns');
    const banned = verdict.violations.find((v) => v.check === 'no-banned-class-patterns')!;
    // Each invented class should appear in the violation detail with a fix.
    expect(banned.detail).toContain('confidence-tag');
    expect(banned.detail).toContain('audience-tag');
    expect(banned.detail).toContain('evolution-pill');
    expect(banned.detail).toContain('ev-product');
    expect(banned.detail).toContain('jtbd-card');
    expect(banned.detail).toContain('stat-grid');
    expect(banned.detail).toContain('experiment-box');
    expect(banned.detail).toContain('refs-list');
  });
});

describe('findOffPaletteFills (P3 chart palette conformance — the false-positive tripwire)', () => {
  const allowed = ['#d4a84b', '#4a9eff', '#3fb68b'];

  it('flags an off-palette fill ATTRIBUTE', () => {
    expect(findOffPaletteFills('<rect fill="#ff00ff" />', allowed)).toContain('#ff00ff');
  });

  it('passes an in-palette fill (case-insensitive)', () => {
    expect(findOffPaletteFills('<rect fill="#D4A84B" /><circle fill="#4a9eff" />', allowed)).toEqual([]);
  });

  it('ignores CSS fill: declarations (colon, not an attribute)', () => {
    expect(findOffPaletteFills('<style>.bar{fill:#ff00ff}</style>', allowed)).toEqual([]);
  });

  it('ignores prose hex mentions', () => {
    expect(findOffPaletteFills('the color #ff00ff reads as off-brand', allowed)).toEqual([]);
  });

  it('ignores rgba()/named/none fills (no false-positive on transparency)', () => {
    expect(findOffPaletteFills('<rect fill="rgba(255,0,255,0.5)" /><rect fill="none" />', allowed)).toEqual([]);
  });

  it('allows white/black neutrals (chart backgrounds, axes)', () => {
    expect(findOffPaletteFills('<rect fill="#ffffff" /><line fill="#000" />', allowed)).toEqual([]);
  });

  it('dedupes repeated off-palette fills', () => {
    expect(findOffPaletteFills('<rect fill="#ff00ff" /><rect fill="#ff00ff" />', allowed)).toEqual(['#ff00ff']);
  });
});

describe('analyzeCreatorBrand advisory palette check (P3 — non-blocking, brief-gated)', () => {
  const brief = resolveDesignBrief('u'); // brand-dark; sequence leads with #d4a84b
  const wrap = (svg: string) => `<html><body>${svg}${'x'.repeat(220)}</body></html>`;

  it('adds an ADVISORY (not a blocking violation) for off-palette chart fills', () => {
    const v = analyzeCreatorBrand(wrap('<svg><rect fill="#ff00ff" /></svg>'), brief);
    expect(v.advisories?.some((a) => a.check === 'chart-palette-conformance')).toBe(true);
    // it must NOT appear in the blocking violations list
    if (!v.ok) expect(v.violations.some((x) => x.check === 'chart-palette-conformance')).toBe(false);
  });

  it('no advisory when charts use the brief palette', () => {
    const v = analyzeCreatorBrand(wrap('<svg><rect fill="#d4a84b" /></svg>'), brief);
    expect(v.advisories).toBeUndefined();
  });

  it('skips the palette check entirely with no brief (back-compat)', () => {
    const v = analyzeCreatorBrand(wrap('<svg><rect fill="#ff00ff" /></svg>'));
    expect(v.advisories).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// User-theme exemption: an explicit user-requested
// non-dark theme must not be gated on the DARK brand stylesheet or palette.
// ---------------------------------------------------------------------------
describe('T1.3 user-theme exemption', () => {
  const bareHtml = `<html><head><title>t</title></head><body>${'x'.repeat(300)}</body></html>`;

  it('skips brand-stylesheet-linked + palette advisory for explicit user light themes', () => {
    const lightUserBrief = resolveDesignBrief('u', { theme: 'brand-light', source: 'user' });
    const v = analyzeCreatorBrand(bareHtml, lightUserBrief);
    const checks = v.ok ? [] : v.violations.map((x) => x.check);
    expect(checks).not.toContain('brand-stylesheet-linked');
    expect((v.advisories ?? []).map((a) => a.check)).not.toContain('chart-palette-conformance');
  });

  it('still requires the brand link for auto (default brand-dark) briefs', () => {
    const v = analyzeCreatorBrand(bareHtml, resolveDesignBrief('u'));
    expect(v.ok).toBe(false);
    expect(v.ok ? [] : v.violations.map((x) => x.check)).toContain('brand-stylesheet-linked');
  });

  it('still requires the brand link for USER-sourced brand-dark briefs (dark = the brand)', () => {
    const darkUserBrief = resolveDesignBrief('u', { theme: 'brand-dark', source: 'user' });
    const v = analyzeCreatorBrand(bareHtml, darkUserBrief);
    expect(v.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SVG-internal <style> is renderer output and
// must not count against the agent's custom-class budget (provenance hashes
// never survive LLM re-typing, so the byte-exact exemption never fired).
// ---------------------------------------------------------------------------
describe('T1.4 svg-internal styles exempt from class budget', () => {
  it('does not report excessive-custom-classes when inventions live inside <svg><style>', () => {
    const svgClasses = Array.from({ length: 14 }, (_, i) => `.svgc-${i}{fill:#000}`).join('');
    const pageClasses = Array.from({ length: 5 }, (_, i) => `.helper-${i}{margin:0}`).join('');
    const html = `<html><head><title>t</title><link rel="stylesheet" href="/css/report-brand.css" /><style>${pageClasses}</style></head><body><svg viewBox="0 0 10 10"><style>${svgClasses}</style></svg>${'x'.repeat(300)}</body></html>`;
    const v = analyzeCreatorBrand(html);
    const checks = v.ok ? [] : v.violations.map((x) => x.check);
    expect(checks).not.toContain('excessive-custom-classes'); // 5 page helpers ≤ 8 budget
  });

  it('does not charge page-level inventions outside svg', () => {
    const pageClasses = Array.from({ length: 12 }, (_, i) => `.helper-${i}{margin:0}`).join('');
    const html = `<html><head><title>t</title><link rel="stylesheet" href="/css/report-brand.css" /><style>${pageClasses}</style></head><body>${'x'.repeat(300)}</body></html>`;
    const v = analyzeCreatorBrand(html);
    expect(v.ok ? [] : v.violations.map((x) => x.check)).not.toContain('excessive-custom-classes');
  });
});

/**
 * REPORT-015 — the analyzer must charge only AUTHOR-owned CSS.
 *
 * The server appends its own `<style data-design-pass="page-theme">` after the
 * report body (`applyPageTheme`), and the composer prepends
 * `<style data-composer="v1">`. Both declare the canonical brand variables on
 * purpose — that block is what decides the rendered palette. Scoring the STORED
 * bytes therefore made the platform's own output look like model shadowing.
 * This fixture proves that removing the server-owned block removes the whole
 * `no-variable-shadowing` finding rather than masking part of it.
 *
 * The publish path sliced the suffix off by string `endsWith`, which is fragile
 * and, critically, protected only that ONE call site: the L1 soft check, the
 * rubric, and any operator probe all read the stored bytes. The exemption
 * belongs in the analyzer, structurally, exactly like the SVG-internal one.
 */
describe('REPORT-015 — platform-owned style blocks are not charged to the author', () => {
  const brandVarBlock = `:root{--bg-primary:#0a0c10;--accent-gold:#d4a84b;--text-primary:#e8eaf0;--border:#21262d}`;
  const body = `<body>${'x'.repeat(300)}</body>`;

  it('does not report variable shadowing for the server-appended page theme', () => {
    const html =
      `<html><head><title>t</title><link rel="stylesheet" href="/css/report-brand.css" /></head>${body}</html>` +
      `<style data-design-pass="page-theme">${brandVarBlock}html,body{background:#0a0c10;color:#e8eaf0;}</style>`;
    const v = analyzeCreatorBrand(html);
    expect(v.ok ? [] : v.violations.map((x) => x.check)).not.toContain('no-variable-shadowing');
  });

  it('does not report variable shadowing for the composer stylesheet', () => {
    const html = `<html><head><title>t</title><link rel="stylesheet" href="/css/report-brand.css" /><style data-composer="v1">${brandVarBlock}</style></head>${body}</html>`;
    const v = analyzeCreatorBrand(html);
    expect(v.ok ? [] : v.violations.map((x) => x.check)).not.toContain('no-variable-shadowing');
  });

  it('does not spend the class budget on the platform blocks', () => {
    const platformClasses = Array.from({ length: 20 }, (_, i) => `.plat-${i}{margin:0}`).join('');
    const html =
      `<html><head><title>t</title><link rel="stylesheet" href="/css/report-brand.css" /></head>${body}</html>` +
      `<style data-design-pass="page-theme">${platformClasses}</style>`;
    const v = analyzeCreatorBrand(html);
    expect(v.ok ? [] : v.violations.map((x) => x.check)).not.toContain('excessive-custom-classes');
  });

  it('STILL reports genuine author shadowing in an ordinary style block', () => {
    // The exemption must be keyed on the platform marker, not on "any :root".
    const html =
      `<html><head><title>t</title><link rel="stylesheet" href="/css/report-brand.css" /><style>${brandVarBlock}</style></head>${body}</html>` +
      `<style data-design-pass="page-theme">${brandVarBlock}</style>`;
    const v = analyzeCreatorBrand(html);
    expect(v.ok ? [] : v.violations.map((x) => x.check)).toContain('no-variable-shadowing');
  });

  it('cannot be spoofed by an author who copies the platform marker into the body', () => {
    // A style block carrying the marker but NOT emitted by the platform would
    // otherwise be a free bypass. The exemption requires the exact byte shape the
    // platform emits, so a hand-written variant with extra attributes is counted.
    const html =
      `<html><head><title>t</title><link rel="stylesheet" href="/css/report-brand.css" /></head>` +
      `<body><style data-design-pass="page-theme" data-author="me">${brandVarBlock}</style>${'x'.repeat(300)}</body></html>`;
    const v = analyzeCreatorBrand(html);
    expect(v.ok ? [] : v.violations.map((x) => x.check)).toContain('no-variable-shadowing');
  });
});

/**
 * REPORT-015 — the brand vocabulary the checker knows must be the vocabulary the
 * stylesheet actually defines.
 *
 * `BRAND_CLASS_NAMES` was hand-typed with a "keep in sync" comment and had
 * drifted by five entries, including `cite-link` (emitted by the `cite-ieee`
 * contract AND by the REPORT-013 publication normalizer) and `report-figure-img`
 * (stamped by the REPORT-014 image bridge). A report styling the platform's own
 * output was therefore charged for inventing a design system.
 *
 * A drift test rather than a runtime read: the analyzer runs inside the Next
 * bundle, and this mirrors the existing `report-brand-palette-drift` proof.
 */
describe('REPORT-015 — brand class vocabulary matches the stylesheet', () => {
  const readStylesheetClasses = (css: string): Set<string> => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    return new Set(Array.from(withoutComments.matchAll(/\.([A-Za-z_][\w-]*)/g), (m) => m[1]));
  };

  it('defines every class report-brand.css declares', () => {
    const css = readFileSync(join(process.cwd(), 'public/css/report-brand.css'), 'utf-8');
    const declared = readStylesheetClasses(css);
    const missing = [...declared].filter((name) => !BRAND_CLASS_NAMES.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('the comparator goes red when the stylesheet gains a class the checker does not know', () => {
    // Non-vacuity: the assertion above must be capable of failing.
    const mutated = '.brand-new-thing { color: red }';
    const declared = readStylesheetClasses(mutated);
    expect([...declared].filter((name) => !BRAND_CLASS_NAMES.has(name))).toEqual(['brand-new-thing']);
  });

  it('does not charge the author for styling the platform-emitted citation and figure classes', () => {
    // Non-vacuity: 5 platform classes + 6 genuine helpers. If the platform
    // classes were still counted the total would be 11 and exceed the budget of
    // 8; counting only the helpers keeps it at 6 and passes. The control below
    // proves the same fixture trips once the helper count alone is excessive.
    const platform =
      '.cite-link{color:inherit}.report-figure-img{border:0}.report-figure{margin:0}.table-scroll{max-width:100%}.toc{padding:0}';
    const helpers = Array.from({ length: 6 }, (_, i) => `.helper-${i}{margin:0}`).join('');
    const html =
      `<html><head><title>t</title><link rel="stylesheet" href="/css/report-brand.css" />` +
      `<style>${platform}${helpers}</style></head><body>${'x'.repeat(300)}</body></html>`;
    const v = analyzeCreatorBrand(html);
    expect(v.ok ? [] : v.violations.map((x) => x.check)).not.toContain('excessive-custom-classes');
  });

  it('does not trip when author helpers exceed the retired budget', () => {
    const platform =
      '.cite-link{color:inherit}.report-figure-img{border:0}.report-figure{margin:0}.table-scroll{max-width:100%}.toc{padding:0}';
    const helpers = Array.from({ length: 9 }, (_, i) => `.helper-${i}{margin:0}`).join('');
    const html =
      `<html><head><title>t</title><link rel="stylesheet" href="/css/report-brand.css" />` +
      `<style>${platform}${helpers}</style></head><body>${'x'.repeat(300)}</body></html>`;
    const v = analyzeCreatorBrand(html);
    expect(v.ok ? [] : v.violations.map((x) => x.check)).not.toContain('excessive-custom-classes');
  });
});
