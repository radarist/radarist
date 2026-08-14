/**
 * Unit tests for the radar PNG-export DOM helpers (jsdom):
 * theme-background resolution and overflow padding measurement.
 */

import { resolveEffectiveBackgroundColor, computeExportPadding } from '../radar-export';

/** Stub a DOMRect-shaped getBoundingClientRect on an element. */
function stubRect(el: HTMLElement, rect: { left: number; top: number; right: number; bottom: number }): void {
  el.getBoundingClientRect = jest.fn(
    () =>
      ({
        ...rect,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        x: rect.left,
        y: rect.top,
        toJSON: () => rect,
      }) as DOMRect
  );
}

describe('resolveEffectiveBackgroundColor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.body.style.backgroundColor = '';
    document.documentElement.style.backgroundColor = '';
  });

  it('returns the element own background when set', () => {
    const el = document.createElement('div');
    el.style.backgroundColor = 'rgb(10, 20, 30)';
    document.body.appendChild(el);
    expect(resolveEffectiveBackgroundColor(el)).toBe('rgb(10, 20, 30)');
  });

  it('walks up to the first non-transparent ancestor (theme background)', () => {
    const parent = document.createElement('div');
    parent.style.backgroundColor = 'rgb(255, 255, 254)'; // light theme bg
    const child = document.createElement('div'); // transparent, like the radar square
    parent.appendChild(child);
    document.body.appendChild(parent);
    expect(resolveEffectiveBackgroundColor(child)).toBe('rgb(255, 255, 254)');
  });

  it('skips explicit transparent values', () => {
    const parent = document.createElement('div');
    parent.style.backgroundColor = 'rgb(3, 7, 18)'; // dark theme bg
    const child = document.createElement('div');
    child.style.backgroundColor = 'transparent';
    parent.appendChild(child);
    document.body.appendChild(parent);
    expect(resolveEffectiveBackgroundColor(child)).toBe('rgb(3, 7, 18)');
  });

  it('falls back when no ancestor paints a background', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(resolveEffectiveBackgroundColor(el)).toBe('#ffffff');
    expect(resolveEffectiveBackgroundColor(el, '#000000')).toBe('#000000');
  });
});

describe('computeExportPadding', () => {
  const makeNode = (offsetWidth: number): HTMLElement => {
    const node = document.createElement('div');
    Object.defineProperty(node, 'offsetWidth', { value: offsetWidth, configurable: true });
    document.body.appendChild(node);
    return node;
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns margin-only padding for a degenerate (zero-size) node', () => {
    const node = makeNode(0);
    stubRect(node, { left: 0, top: 0, right: 0, bottom: 0 });
    expect(computeExportPadding(node, '[data-radar-quadrant-label]', 12)).toEqual({
      left: 12,
      top: 12,
      right: 12,
      bottom: 12,
    });
  });

  it('measures per-side overflow of the marked labels plus the margin', () => {
    const node = makeNode(800);
    stubRect(node, { left: 100, top: 100, right: 900, bottom: 900 });

    // Label sticking out 40px to the left and 10px above.
    const labelA = document.createElement('div');
    labelA.setAttribute('data-radar-quadrant-label', '');
    stubRect(labelA, { left: 60, top: 90, right: 300, bottom: 120 });
    node.appendChild(labelA);

    // Label sticking out 75px to the right and 25px below.
    const labelB = document.createElement('div');
    labelB.setAttribute('data-radar-quadrant-label', '');
    stubRect(labelB, { left: 700, top: 800, right: 975, bottom: 925 });
    node.appendChild(labelB);

    expect(computeExportPadding(node, '[data-radar-quadrant-label]', 12)).toEqual({
      left: 52, // 40 overflow + 12 margin
      top: 22, // 10 + 12
      right: 87, // 75 + 12
      bottom: 37, // 25 + 12
    });
  });

  it('divides out ancestor zoom scale (screen px → layout px)', () => {
    const node = makeNode(400); // layout 400px, rendered 800px → scale 2
    stubRect(node, { left: 0, top: 0, right: 800, bottom: 800 });

    const label = document.createElement('div');
    label.setAttribute('data-radar-quadrant-label', '');
    stubRect(label, { left: -100, top: 10, right: 50, bottom: 40 }); // 100 screen px left overflow
    node.appendChild(label);

    const padding = computeExportPadding(node, '[data-radar-quadrant-label]', 12);
    expect(padding.left).toBe(62); // 100 / 2 + 12
    expect(padding.top).toBe(12);
  });

  it('ignores elements not matching the overflow selector', () => {
    const node = makeNode(800);
    stubRect(node, { left: 0, top: 0, right: 800, bottom: 800 });

    const stray = document.createElement('div');
    stubRect(stray, { left: -500, top: -500, right: 1300, bottom: 1300 });
    node.appendChild(stray);

    expect(computeExportPadding(node, '[data-radar-quadrant-label]', 12)).toEqual({
      left: 12,
      top: 12,
      right: 12,
      bottom: 12,
    });
  });
});
