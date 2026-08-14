/**
 * The strict-args guard must not abort the product's own mandated publish
 * workflow.
 *
 * `publishReport` stages an export, then `design-pass` and `critique-report` must
 * each review that staged export, and publish is called again after each. The args
 * are necessarily identical across all three calls — it is the same report. The
 * Three identical publish calls separated by distinct review work are progress,
 * not a loop.
 *
 * A true loop is a call repeated with nothing accomplished between the repeats.
 * These tests pin both halves of that: consecutive repeats still abort, repeats
 * separated by real work do not.
 */
import { Watchdog, DEFAULT_WATCHDOG_CONFIG } from '../src/hooks/watchdog';

const publishArgs = { slotName: 'main', title: 'The Sustainable Innovation Operating System' };

function makeWatchdog() {
  const aborts: string[] = [];
  const wd = new Watchdog(DEFAULT_WATCHDOG_CONFIG, { onAbort: (reason: string) => aborts.push(reason) });
  return { wd, aborts };
}

describe('strict-args loop guard', () => {
  it('does NOT abort the mandated publish workflow: publish → design-pass → publish → critique → publish', () => {
    const { wd, aborts } = makeWatchdog();

    wd.recordToolCall('mcp__impulse-reports__publishReport', publishArgs);
    wd.recordToolCall('Skill', { skill: 'design-pass', args: 'Review staged export e825268902…' });
    wd.recordToolCall('mcp__impulse-reports__publishReport', publishArgs);
    wd.recordToolCall('Skill', { skill: 'critique-report', args: 'Critique staged export e825268902…' });
    wd.recordToolCall('mcp__impulse-reports__publishReport', publishArgs);

    expect(aborts).toEqual([]);
    expect(wd.aborted).toBe(false);
  });

  it('still aborts a genuine loop: the same call repeated back-to-back with nothing in between', () => {
    const { wd, aborts } = makeWatchdog();

    wd.recordToolCall('mcp__impulse-reports__publishReport', publishArgs);
    wd.recordToolCall('mcp__impulse-reports__publishReport', publishArgs);
    wd.recordToolCall('mcp__impulse-reports__publishReport', publishArgs);

    expect(wd.aborted).toBe(true);
    expect(aborts[0]).toMatch(/consecutively/);
    expect(aborts[0]).toMatch(/no other tool call in between/);
  });

  it('does not let one intervening call license unbounded repetition of a stuck call', () => {
    // A pathological alternation A,B,A,B,A,B… is not what this guard is for — the
    // H7 diversity heuristic and the window-saturation backstop cover that case.
    // What matters here is that the strict guard no longer fires on legitimate
    // interleaving, which the previous test proves, while back-to-back repeats
    // still abort immediately, which the test above proves.
    const { wd } = makeWatchdog();
    wd.recordToolCall('someTool', { a: 1 });
    wd.recordToolCall('otherTool', { b: 2 });
    wd.recordToolCall('someTool', { a: 1 });
    expect(wd.aborted).toBe(false);
  });
});
