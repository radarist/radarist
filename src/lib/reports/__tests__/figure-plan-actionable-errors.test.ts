/**
 * COORD-011: figurePlan rejections must name what would satisfy them.
 *
 * `visualKind` and `sourceIds` rejections otherwise force a full report redraft
 * and repeated guesses. The messages below use the same treatment already
 * applied to diagram data errors: state the offending value AND the accepted set.
 */
import { parseFigurePlan, FigurePlanError } from '../figure-plan';
import type { ScoutBundle } from '@/lib/schemas/scout-bundle';

const bundle = {
  findings: [
    'Reporting stringency inverted inside 31 months [1][2].',
    'Data-centre demand is the binding constraint [3].',
  ],
  sources: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 8 }],
} as unknown as ScoutBundle;

const plan = (over: Record<string, unknown>) =>
  JSON.stringify([
    {
      figureId: 'fig-reversal',
      readerQuestion: 'How fast did reporting stringency invert?',
      visualKind: 's-curve',
      findingIds: [1],
      sourceIds: [1],
      ...over,
    },
  ]);

describe('figurePlan rejections are actionable', () => {
  it('accepts a coherent plan', () => {
    expect(parseFigurePlan(plan({}), bundle)).toHaveLength(1);
  });

  it('names the offending visualKind AND lists every accepted kind', () => {
    let message = '';
    try {
      parseFigurePlan(plan({ visualKind: 'regulatory-timeline' }), bundle);
    } catch (error) {
      message = (error as FigurePlanError).message;
    }
    // The author's invented value is quoted back...
    expect(message).toContain("'regulatory-timeline' is not a supported visualKind");
    // ...and the accepted set is printed, so no guessing round-trip is needed.
    expect(message).toContain('s-curve');
    expect(message).toContain('tech-radar');
    expect(message).toContain('table');
    // The old message carried no remedy at all.
    expect(message).not.toBe('must be a supported chart or static analytical kind');
  });

  it('names the sources the planned findings actually cite', () => {
    let message = '';
    try {
      // Finding 1 cites [1] and [2]; source 3 is real but uncited by it.
      parseFigurePlan(plan({ findingIds: [1], sourceIds: [3] }), bundle);
    } catch (error) {
      message = (error as FigurePlanError).message;
    }
    expect(message).toContain('source 3 is not cited by its planned findings');
    expect(message).toContain('F1');
    // The remedy: the set it COULD have used.
    expect(message).toContain('[1], [2]');
    expect(message).toContain('use sourceIds from that set');
  });

  it('still reports a genuinely absent source as absent', () => {
    expect(() => parseFigurePlan(plan({ sourceIds: [99] }), bundle)).toThrow(/source 99 is absent/);
  });
});
