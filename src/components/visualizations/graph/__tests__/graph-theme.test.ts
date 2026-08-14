/**
 * UX-070 — the graph canvas must take its colours from the app's theme tokens.
 *
 * The stylesheet it replaced used literals (`#e2e8f0` edge ink, `#0f172a` plate,
 * `rgba(15,23,42,0.35)` node border) that were correct in exactly one theme; the
 * border in particular read as grime around every node on a dark canvas.
 */

import { GRAPH_THEME_FALLBACKS, hslTokenToHex, readGraphThemeTokens } from '../graph-theme';

describe('hslTokenToHex', () => {
  it('converts the real globals.css tokens for both themes', () => {
    // Light block of src/app/globals.css.
    expect(hslTokenToHex('0 0% 100%')).toBe('#ffffff'); // --background / --card
    expect(hslTokenToHex('282 44% 18%')).toBe('#361a42'); // --foreground
    expect(hslTokenToHex('214.3 31.8% 91.4%')).toBe('#e2e8f0'); // --border

    // Dark block.
    expect(hslTokenToHex('240 10% 3.9%')).toBe('#09090b'); // --background
    expect(hslTokenToHex('0 0% 98%')).toBe('#fafafa'); // --foreground
    expect(hslTokenToHex('240 5% 17%')).toBe('#29292e'); // --border
  });

  it('accepts the comma-separated form and passes resolved hex through', () => {
    expect(hslTokenToHex('240, 10%, 3.9%')).toBe(hslTokenToHex('240 10% 3.9%'));
    expect(hslTokenToHex('#3b82f6')).toBe('#3b82f6');
    expect(hslTokenToHex('  #fff  ')).toBe('#fff');
  });

  it('handles achromatic and wrapped hues', () => {
    expect(hslTokenToHex('0 0% 0%')).toBe('#000000');
    expect(hslTokenToHex('360 0% 50%')).toBe('#808080');
    // Hue is taken modulo 360 rather than clamped.
    expect(hslTokenToHex('480 100% 50%')).toBe(hslTokenToHex('120 100% 50%'));
  });

  it('returns null for anything it cannot interpret, so the caller can fall back', () => {
    // Feeding Cytoscape an unparseable colour makes it silently drop the property,
    // which is worse than an explicit fallback.
    for (const bad of ['', '   ', 'not a color', '240 10%', 'var(--card)', '240 x% 4%', '240 -5% 50%']) {
      expect({ input: bad, hex: hslTokenToHex(bad) }).toEqual({ input: bad, hex: null });
    }
  });
});

describe('readGraphThemeTokens', () => {
  it('resolves every canvas role from the live custom properties', () => {
    const element = document.createElement('div');
    element.style.setProperty('--card', '240 10% 6%');
    element.style.setProperty('--foreground', '0 0% 98%');
    element.style.setProperty('--muted-foreground', '240 5% 65%');
    element.style.setProperty('--border', '240 5% 17%');
    element.style.setProperty('--muted', '240 5% 15%');
    document.body.appendChild(element);

    try {
      const tokens = readGraphThemeTokens(element);
      expect(tokens).toEqual({
        surface: hslTokenToHex('240 10% 6%'),
        ink: hslTokenToHex('0 0% 98%'),
        mutedInk: hslTokenToHex('240 5% 65%'),
        line: hslTokenToHex('240 5% 17%'),
        ring: hslTokenToHex('240 5% 15%'),
      });
      // Proves the canvas actually follows the theme rather than a baked-in set.
      expect(tokens.surface).not.toBe(GRAPH_THEME_FALLBACKS.surface);
      expect(tokens.ink).not.toBe(GRAPH_THEME_FALLBACKS.ink);
    } finally {
      element.remove();
    }
  });

  it('produces different colours for the light and dark token sets', () => {
    const build = (tokens: Record<string, string>) => {
      const element = document.createElement('div');
      for (const [property, value] of Object.entries(tokens)) element.style.setProperty(property, value);
      document.body.appendChild(element);
      try {
        return readGraphThemeTokens(element);
      } finally {
        element.remove();
      }
    };

    const light = build({
      '--card': '0 0% 100%',
      '--foreground': '282 44% 18%',
      '--muted-foreground': '215.4 16.3% 46.9%',
      '--border': '214.3 31.8% 91.4%',
      '--muted': '210 40% 96.1%',
    });
    const dark = build({
      '--card': '240 10% 6%',
      '--foreground': '0 0% 98%',
      '--muted-foreground': '240 5% 65%',
      '--border': '240 5% 17%',
      '--muted': '240 5% 15%',
    });

    for (const role of ['surface', 'ink', 'mutedInk', 'line', 'ring'] as const) {
      expect({ role, same: light[role] === dark[role] }).toEqual({ role, same: false });
    }
  });

  it('falls back per-role rather than losing the whole canvas to one bad token', () => {
    const element = document.createElement('div');
    element.style.setProperty('--card', '240 10% 6%');
    element.style.setProperty('--foreground', 'not-a-token');
    document.body.appendChild(element);

    try {
      const tokens = readGraphThemeTokens(element);
      expect(tokens.surface).toBe(hslTokenToHex('240 10% 6%'));
      expect(tokens.ink).toBe(GRAPH_THEME_FALLBACKS.ink);
    } finally {
      element.remove();
    }
  });

  it('returns the documented fallbacks when there is no element to read', () => {
    expect(readGraphThemeTokens(null)).toEqual(GRAPH_THEME_FALLBACKS);
    // The fallbacks MIRROR the light theme token-for-token; they are not a second
    // palette that could drift away from globals.css.
    expect(GRAPH_THEME_FALLBACKS).toEqual({
      surface: hslTokenToHex('0 0% 100%'), // --card
      ink: hslTokenToHex('282 44% 18%'), // --foreground
      mutedInk: hslTokenToHex('215.4 16.3% 46.9%'), // --muted-foreground
      line: hslTokenToHex('214.3 31.8% 91.4%'), // --border
      ring: hslTokenToHex('210 40% 96.1%'), // --muted
    });
    for (const value of Object.values(GRAPH_THEME_FALLBACKS)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
