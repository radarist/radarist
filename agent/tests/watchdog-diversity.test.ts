/**
 * H7 diversity gate — regression coverage for the soft-loop false abort.
 *
 * Counting how often a tool fires conflates two opposite behaviours: an agent
 * issuing N calls with N different argument sets is covering different ground,
 * while an agent rephrasing one request is spinning. Argument diversity is the
 * signal that separates them, and the strict-args guard already catches exact
 * repeats.
 *
 * Eight DISTINCT `select:` batches are the documented ToolSearch shape and
 * must not be treated as a repeated call. These tests pin that semantics.
 *
 * The legacy name-count expectations are updated alongside these regressions:
 * a diverse call sequence is allowed until one tool saturates the rolling
 * window, while exact duplicates and low-diversity rephrasing still abort.
 */
import { Watchdog } from '../src/hooks/watchdog';

const GRAPH = 'mcp__impulse-graph__searchKnowledgeGraph';
const TOOL_SEARCH = 'ToolSearch';

describe('Watchdog — H7 diversity gate', () => {
  it('allows 8 DISTINCT ToolSearch batches', () => {
    const w = new Watchdog();
    const batches = [
      'select:mcp__impulse-graph__getGraphAnalytics,mcp__impulse-graph__getGraphHealth',
      'select:mcp__impulse-radar__listRadars,mcp__impulse-signals__getTrends',
      'select:mcp__super-graph__renderDiagram,mcp__gemini-image__generate_image',
      'select:mcp__impulse-graph__getClaimHealth,mcp__impulse-graph__getChangedSince',
      'select:mcp__impulse-reports__draftReport,mcp__impulse-reports__publishReport',
      'select:mcp__impulse-graph__findPaths,mcp__impulse-graph__getGapAnalysis',
      'select:mcp__impulse-entities__listEntities',
      'select:mcp__impulse-graph__listCommunityClusters',
    ];
    for (const query of batches) w.recordToolCall(TOOL_SEARCH, { query, max_results: 6 });
    expect(w.aborted).toBe(false);
  });

  it('aborts a low-diversity rephrasing loop that evades the strict-args guard', () => {
    const w = new Watchdog();
    // Eight calls over four argument sets, each used twice: no fingerprint
    // reaches the 3x strict-duplicate threshold, but diversity (4) falls under
    // the required ceil(8 * 0.6) = 5.
    for (let i = 0; i < 8; i++) w.recordToolCall(TOOL_SEARCH, { query: `variant-${i % 4}` });
    expect(w.aborted).toBe(true);
    expect(w.abortReason).toContain('distinct argument set');
  });

  it('stops one tool monopolising the window even when every call differs', () => {
    const w = new Watchdog();
    for (let i = 0; i < 18; i++) w.recordToolCall(GRAPH, { query: `unique-${i}` });
    expect(w.aborted).toBe(true);
    expect(w.abortReason).toContain('window saturated');
  });

  it('keeps the strict-args duplicate guard ahead of the diversity gate', () => {
    const w = new Watchdog();
    for (let i = 0; i < 3; i++) w.recordToolCall(TOOL_SEARCH, { query: 'identical' });
    expect(w.aborted).toBe(true);
    expect(w.abortReason).toContain('identical args');
  });

  it('leaves a legitimate multi-chart render sequence alone', () => {
    const w = new Watchdog();
    for (let i = 0; i < 12; i++) {
      w.recordToolCall('mcp__super-graph__renderDiagram', { kind: 'labeled-scatter', title: `figure-${i}` });
    }
    expect(w.aborted).toBe(false);
  });
});
