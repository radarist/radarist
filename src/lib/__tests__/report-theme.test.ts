import { reportThemeStyleForBrief, applyPageTheme } from '@/lib/report-theme';
import type { DesignBrief } from '@/lib/schemas/design-brief';

const premium: DesignBrief = {
  theme: 'brand-light',
  source: 'user',
  palette: {
    bg: '#f6f2ea',
    surface: '#fffdf8',
    ink: '#2e2a26',
    accent: '#9c7c3c',
    sequence: ['#9c7c3c', '#3f5e5a', '#7d4a52', '#4d5a6b', '#6a6f45', '#856a8a', '#a96f4c', '#5c6b6f'],
  },
  typography: { display: 'serif', body: 'sans-serif' },
  infographicStyle: 'Premium editorial — warm ivory, muted accents, no neon, no black',
  visualAmbition: 'standard',
};

describe('reportThemeStyleForBrief', () => {
  it('returns empty string when no brief', () => {
    expect(reportThemeStyleForBrief(undefined)).toBe('');
  });

  it('maps the brief palette onto report-brand.css :root variables', () => {
    const css = reportThemeStyleForBrief(premium);
    expect(css).toContain('--bg-primary:#f6f2ea');
    expect(css).toContain('--bg-card:#fffdf8');
    expect(css).toContain('--text-primary:#2e2a26');
    expect(css).toContain('--accent-gold:#9c7c3c');
    expect(css).toContain('--accent-blue:#3f5e5a'); // sequence[1], NOT the neon #4a9eff default
    // pins the page surface itself
    expect(css).toContain('background:#f6f2ea');
    expect(css).toContain('color:#2e2a26');
  });

  it('overrides the brand-dark defaults — no black bg, no neon blue', () => {
    const css = reportThemeStyleForBrief(premium);
    expect(css).not.toContain('#0a0c10'); // brand-dark bg default
    expect(css).not.toContain('#4a9eff'); // neon-blue default
  });

  it('derives secondary/muted/border by blending ink toward bg (between the two)', () => {
    const css = reportThemeStyleForBrief(premium);
    // a derived value must be present and not equal to either pure endpoint
    const m = css.match(/--text-secondary:(#[0-9a-f]{6})/i);
    expect(m).toBeTruthy();
    expect(m![1].toLowerCase()).not.toBe('#2e2a26'); // not pure ink
    expect(m![1].toLowerCase()).not.toBe('#f6f2ea'); // not pure bg
  });

  it('overrides --bg-card-alt (drives table/.stat/.timeline/figure surfaces) to a light shade', () => {
    const css = reportThemeStyleForBrief(premium);
    const m = css.match(/--bg-card-alt:(#[0-9a-f]{6})/i);
    expect(m).toBeTruthy();
    // light shade near the surface, NOT the agent's dark #0a0f2e default
    expect(m![1].toLowerCase()).not.toBe('#0a0f2e');
  });

  it('overrides the SHORT alias var names the components actually use (--text/--bg/--accent/--gold)', () => {
    const css = reportThemeStyleForBrief(premium);
    expect(css).toContain('--text:#2e2a26'); // section headings → ink, not washed-out
    expect(css).toContain('--bg:#f6f2ea');
    expect(css).toContain('--accent:#9c7c3c');
    expect(css).toContain('--gold:#9c7c3c');
  });
});

describe('applyPageTheme', () => {
  it('returns html unchanged when no brief', () => {
    const html = '<div style="background:#0f172a">x</div>';
    expect(applyPageTheme(html, undefined)).toBe(html);
  });

  it('preserves hardcoded dark surfaces — no luminance flattening', () => {
    const html = '<style>.a{background:#161b22}.b{background:#0f1115}th{background:#0f172a}</style>';
    const out = applyPageTheme(html, premium);
    expect(out).toContain('#161b22'); // distinct surfaces preserved
    expect(out).toContain('#0f1115');
    expect(out).toContain('#0f172a');
  });

  it('T1.2: preserves hardcoded light text and dark gradients', () => {
    const html =
      '<div style="background:#0f172a;color:#fff">106</div><style>thead{background:linear-gradient(135deg,#1a2454,#0d1535)}</style>';
    const out = applyPageTheme(html, premium);
    expect(out).toMatch(/color\s*:\s*#fff\b/i); // light text untouched
    expect(out).toContain('#1a2454'); // gradient stops untouched
    expect(out).toContain('#0d1535');
  });

  it('T1.2: preserves gradient-clipped headings (-webkit-text-fill-color:transparent)', () => {
    const html =
      '<style>.hero h1{background:linear-gradient(135deg,#f1f5f9,#94a3b8);-webkit-text-fill-color:transparent;background-clip:text}</style>';
    const out = applyPageTheme(html, premium);
    expect(out).toMatch(/-webkit-text-fill-color\s*:\s*transparent/i);
  });

  it('still appends the :root page-theme block and maps --cyan onto the brief sequence', () => {
    const out = applyPageTheme('<table></table>', premium);
    expect(out).toContain('data-design-pass="page-theme"');
    expect(out).toContain('--cyan:#3f5e5a'); // sequence[1], not an undefined neon cyan
  });

  it('does not modify any pre-suffix byte of the input html', () => {
    const html = '<div style="background:#1e3a5f;color:#cbd5e1">Hero</div>';
    const out = applyPageTheme(html, premium);
    expect(out.startsWith(html)).toBe(true); // suffix-only theming
  });
});

describe('REPORT-016: --accent-gold-light is actually lighter than --accent-gold', () => {
  // sRGB relative luminance — the property the variable NAME promises.
  const lum = (hex: string): number => {
    const n = parseInt(hex.replace('#', ''), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const varOf = (css: string, name: string): string => {
    const m = new RegExp(`${name}:(#[0-9a-f]{6})`, 'i').exec(css);
    if (!m) throw new Error(`${name} not emitted`);
    return m[1];
  };

  it('lightens on a DARK brief (regression: mix toward bg made it darker)', () => {
    // The shipped defect: `mix(accent, bg, 0.28)` blends toward the page
    // background, which on brand-dark is near-black — so the "light" gold
    // resolved to #9b7c3a, DARKER than #d4a84b, reversing --gradient-gold.
    const css = reportThemeStyleForBrief({
      ...premium,
      theme: 'brand-dark',
      palette: { bg: '#0a0c10', surface: '#161b22', ink: '#e8eaf0', accent: '#d4a84b', sequence: ['#d4a84b'] },
    });
    expect(lum(varOf(css, '--accent-gold-light'))).toBeGreaterThan(lum('#d4a84b'));
  });

  it('still lightens on a LIGHT brief (behaviour there was already correct)', () => {
    const css = reportThemeStyleForBrief(premium);
    expect(lum(varOf(css, '--accent-gold-light'))).toBeGreaterThan(lum(premium.palette.accent));
  });
});

describe('semantic accent mapping (template polish, 2026-07-20)', () => {
  it('maps green/red/purple to the canonical sequence positions', () => {
    const css = reportThemeStyleForBrief(premium);
    // premium.sequence: [0]#9c7c3c [1]#3f5e5a [2]#7d4a52 [3]#4d5a6b [4]#6a6f45
    expect(css).toContain('--accent-green:#7d4a52'); // seq[2]
    expect(css).toContain('--accent-red:#4d5a6b'); // seq[3]
    expect(css).toContain('--accent-purple:#6a6f45'); // seq[4]
  });
});

/**
 * COORD-021 — the suffix owns the page on screen AND releases it for paper.
 *
 * The exact product export `570dd894…` printed dark ink on a #0a0c10 page:
 * media queries carry no specificity, so this block's unconditional `html,body`
 * pin beat the author's own `@media print` rules and `report-brand.css`'s print
 * block (which remaps `:root` but never sets a page background).
 */
describe('print release (COORD-021)', () => {
  it('keeps the screen pin byte-identical and appends the print block after it', () => {
    const css = reportThemeStyleForBrief(premium);
    const pin = `html,body{background:${premium.palette.bg};color:${premium.palette.ink};}`;
    expect(css).toContain(pin);
    // Appended, never rewritten — publish-report-tool matches the pin exactly.
    expect(css.indexOf(pin)).toBeLessThan(css.indexOf('@media print'));
  });

  it('forces a light page with !important, since the screen pin is a later equal-specificity rule', () => {
    const css = reportThemeStyleForBrief(premium);
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(/html,body\{background:#ffffff !important;color:#111318 !important;\}/);
  });

  it('remaps the page variables for paper so var-driven brand CSS follows', () => {
    const print = reportThemeStyleForBrief(premium).slice(reportThemeStyleForBrief(premium).indexOf('@media print'));
    expect(print).toContain('--bg-primary:#ffffff;');
    expect(print).toContain('--text-primary:#111318;');
  });

  it('emits no print block when there is no brief to theme', () => {
    expect(reportThemeStyleForBrief(undefined)).toBe('');
    expect(applyPageTheme('<p>x</p>', undefined)).toBe('<p>x</p>');
  });

  it('leaves the brand-dark page dark on screen — theme identity is not weakened', () => {
    const dark: DesignBrief = {
      ...premium,
      palette: { ...premium.palette, bg: '#0a0c10', ink: '#e8eaf0' },
    };
    const css = reportThemeStyleForBrief(dark);
    expect(css.slice(0, css.indexOf('@media print'))).toContain('html,body{background:#0a0c10;color:#e8eaf0;}');
  });
});
