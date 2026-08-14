import { computeLayout } from '../../templates/tech-radar-layout';

const RADIUS = 380;
const FONT = 13; // px (matches type.scale.small in light editorial)
const CHAR_WIDTH = 6.4; // approx Inter average char width at 13px
const CENTER = { x: 800, y: 480 };

const QUADRANTS = [
  { id: 'q0', name: 'Q1', order: 0 },
  { id: 'q1', name: 'Q2', order: 1 },
  { id: 'q2', name: 'Q3', order: 2 },
  { id: 'q3', name: 'Q4', order: 3 },
];
const RINGS = ['ADOPT', 'TRIAL', 'ASSESS', 'HOLD'];

function bbox(label: { x: number; y: number; w: number; h: number }) {
  return { x1: label.x, y1: label.y, x2: label.x + label.w, y2: label.y + label.h };
}
function overlaps(a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>) {
  return !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1);
}

describe('computeLayout', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    name: `Tech ${i + 1}`,
    quadrantId: `q${i % 4}`,
    ring: RINGS[i % 4],
  }));

  it('places every item — none silently dropped', () => {
    const result = computeLayout({
      items,
      quadrants: QUADRANTS,
      rings: RINGS,
      radius: RADIUS,
      fontSize: FONT,
      charWidth: CHAR_WIDTH,
      center: CENTER,
    });
    expect(result.placed.length + result.overflow.length).toBe(items.length);
  });

  it('emits no two label bboxes that overlap', () => {
    const { placed } = computeLayout({
      items,
      quadrants: QUADRANTS,
      rings: RINGS,
      radius: RADIUS,
      fontSize: FONT,
      charWidth: CHAR_WIDTH,
      center: CENTER,
    });
    const boxes = placed.map((p) => bbox(p.labelBox));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (overlaps(boxes[i], boxes[j])) {
          throw new Error(`labels ${i} and ${j} overlap: ${JSON.stringify({ a: boxes[i], b: boxes[j] })}`);
        }
      }
    }
  });

  it('items pushed to overflow have a number and a legend entry', () => {
    // Force-overflow by using a tiny radius so labels can't all fit inline.
    const { overflow } = computeLayout({
      items,
      quadrants: QUADRANTS,
      rings: RINGS,
      radius: 80,
      fontSize: FONT,
      charWidth: CHAR_WIDTH,
      center: CENTER,
    });
    if (overflow.length > 0) {
      for (const o of overflow) {
        expect(o.legendNumber).toBeGreaterThan(0);
        expect(typeof o.name).toBe('string');
      }
    }
  });

  it('is deterministic — same input → same output', () => {
    const a = computeLayout({
      items,
      quadrants: QUADRANTS,
      rings: RINGS,
      radius: RADIUS,
      fontSize: FONT,
      charWidth: CHAR_WIDTH,
      center: CENTER,
    });
    const b = computeLayout({
      items,
      quadrants: QUADRANTS,
      rings: RINGS,
      radius: RADIUS,
      fontSize: FONT,
      charWidth: CHAR_WIDTH,
      center: CENTER,
    });
    expect(a).toEqual(b);
  });
});
