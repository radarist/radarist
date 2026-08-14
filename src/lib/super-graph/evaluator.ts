import type { DesignTokens } from './design-tokens';
import { isTokenBlend, parseHexColor } from './color-blend';

export interface EvalInput {
  kind: string;
  aspect: '16:9' | '4:3' | '1:1' | '21:9' | 'free';
}
export interface EvalIssue {
  severity: 'low' | 'med' | 'high';
  dimension: 'token-compliance' | 'aspect' | 'density' | 'whitespace' | 'contrast' | 'collision';
  detail: string;
  fix?: string;
}
export interface EvalResult {
  verdict: 'PASS' | 'REVISE';
  issues: EvalIssue[];
}

const ASPECT_RATIOS: Record<EvalInput['aspect'], number | null> = {
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '1:1': 1,
  '21:9': 21 / 9,
  free: null,
};

export function evaluateSvg(svg: string, ev: EvalInput, t: DesignTokens): EvalResult {
  const issues: EvalIssue[] = [];

  // Token compliance — every fill/stroke hex must be in the allow set.
  const allowedColors = new Set(
    [
      t.color.canvas,
      t.color.surface,
      t.color.ink,
      t.color.muted,
      t.color.rule,
      ...t.color.sequence,
      t.color.positive,
      t.color.negative,
      t.color.warning,
      t.color.info,
    ].map((c) => c.toLowerCase())
  );

  // Broadened to catch:
  //   - attribute form: fill="#hex" / stroke="#hex"
  //   - CSS form inside <style> blocks: fill:#hex / stroke:#hex (Mermaid leaks these)
  //   - ECharts/CSS rgb(...) form: fill="rgb(r,g,b)" / fill:rgb(r,g,b)
  //   - HSL form: fill="hsl(h,s,l)" / fill:hsl(...) — Mermaid mindmap pre-v12
  //     emits these per section. Always considered off-token (defense-in-depth;
  //     themeCSS overrides should prevent fresh emissions).
  // Linear blends of two allowed colors are compliant: continuous visualMap
  // ramps interpolate between token stops, and those interpolants are exactly
  // as brand-derived as the stops themselves. Same predicate as the tool's
  // palette sweep (color-blend.ts) so the evaluator never fails what the
  // sweep deliberately preserves.
  const allowRgb: Array<[number, number, number]> = [];
  for (const c of allowedColors) {
    const rgb = parseHexColor(c);
    if (rgb) allowRgb.push(rgb);
  }

  const colorRe = /(?:fill|stroke)\s*[:=]\s*["']?(#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/g;
  let m: RegExpExecArray | null;
  const offending: string[] = [];
  while ((m = colorRe.exec(svg)) !== null) {
    const raw = m[1];
    let c: string | null;
    if (raw.startsWith('#')) {
      c = raw.toLowerCase();
    } else if (raw.startsWith('rgb(')) {
      c = rgbToHex(raw);
    } else {
      // HSL: bypass the allow-list — always considered off-token.
      offending.push(raw.toLowerCase());
      continue;
    }
    if (c && !allowedColors.has(c) && !isTokenBlend(c, allowRgb)) offending.push(c);
  }
  if (offending.length > 0) {
    issues.push({
      severity: 'high',
      dimension: 'token-compliance',
      detail: `Off-token colors found: ${[...new Set(offending)].join(', ')}`,
      fix: 'replace with nearest token color',
    });
  }

  // Aspect compliance.
  const target = ASPECT_RATIOS[ev.aspect];
  if (target !== null) {
    const vb = svg.match(/viewBox="([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
    if (vb) {
      const w = parseFloat(vb[3]);
      const h = parseFloat(vb[4]);
      const actual = w / h;
      const ratioErr = Math.abs(actual - target) / target;
      if (ratioErr > 0.1) {
        issues.push({
          severity: 'med',
          dimension: 'aspect',
          detail: `viewBox aspect ${actual.toFixed(2)} differs from declared ${ev.aspect} by ${(ratioErr * 100).toFixed(0)}%`,
          fix: 'adjust viewBox',
        });
      }
    } else {
      issues.push({ severity: 'low', dimension: 'aspect', detail: 'no viewBox' });
    }
  }

  // (Density / collision / whitespace heuristics deferred until first regression — keep Layer A small to avoid false positives blocking real-world data.)

  return { verdict: issues.length === 0 ? 'PASS' : 'REVISE', issues };
}

/** Convert an `rgb(r, g, b)` string to lowercase `#rrggbb`. Returns null on parse failure. */
function rgbToHex(rgb: string): string | null {
  const m = rgb.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map((n) => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
}
