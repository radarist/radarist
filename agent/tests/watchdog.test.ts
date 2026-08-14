/** Watchdog soft-loop heuristics for distinct graph searches. */
import { Watchdog } from '../src/hooks/watchdog';

const GRAPH = 'mcp__impulse-graph__searchKnowledgeGraph';

describe('Watchdog — searchKnowledgeGraph per-tool override', () => {
  it('allows 10 DISTINCT graph searches', () => {
    const w = new Watchdog();
    for (let i = 0; i < 10; i++) w.recordToolCall(GRAPH, { query: `distinct-${i}` });
    expect(w.aborted).toBe(false);
  });

  it('allows 15 DISTINCT graph searches (under the 16 cap)', () => {
    const w = new Watchdog();
    for (let i = 0; i < 15; i++) w.recordToolCall(GRAPH, { query: `d-${i}` });
    expect(w.aborted).toBe(false);
  });

  it('allows 16 distinct graph searches because the calls are still diverse', () => {
    const w = new Watchdog();
    for (let i = 0; i < 16; i++) w.recordToolCall(GRAPH, { query: `x-${i}` });
    expect(w.aborted).toBe(false);
  });

  it('backstops an all-search run when it saturates 90% of the rolling window', () => {
    const w = new Watchdog();
    for (let i = 0; i < 18; i++) w.recordToolCall(GRAPH, { query: `x-${i}` });
    expect(w.aborted).toBe(true);
    expect(w.abortReason).toContain('window saturated');
  });

  it('still aborts on 3 IDENTICAL graph queries (true-loop guard intact)', () => {
    const w = new Watchdog();
    for (let i = 0; i < 3; i++) w.recordToolCall(GRAPH, { query: 'same' });
    expect(w.aborted).toBe(true);
  });

  it('does not mistake eight distinct mutations for a loop solely by tool name', () => {
    const w = new Watchdog();
    for (let i = 0; i < 8; i++) w.recordToolCall('mcp__impulse-entities__createCompany', { name: `c-${i}` });
    expect(w.aborted).toBe(false);
  });
});
