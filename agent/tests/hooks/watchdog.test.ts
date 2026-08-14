import { jest } from '@jest/globals';
import { Watchdog, DEFAULT_WATCHDOG_CONFIG } from '../../src/hooks/watchdog';

describe('Watchdog', () => {
  describe('fingerprint repetition', () => {
    it('should abort after duplicateThreshold identical tool calls', () => {
      const aborts: string[] = [];
      const wd = new Watchdog(DEFAULT_WATCHDOG_CONFIG, { onAbort: (r) => aborts.push(r) });

      // Default duplicateThreshold = 3
      wd.recordToolCall('exa_search', { query: 'hello' });
      wd.recordToolCall('exa_search', { query: 'hello' });
      expect(aborts).toHaveLength(0);
      wd.recordToolCall('exa_search', { query: 'hello' });

      expect(aborts).toHaveLength(1);
      expect(aborts[0]).toContain('exa_search');
      expect(aborts[0]).toContain('3×');
      expect(wd.aborted).toBe(true);
    });

    it('should not count different args as duplicates', () => {
      const aborts: string[] = [];
      const wd = new Watchdog(DEFAULT_WATCHDOG_CONFIG, { onAbort: (r) => aborts.push(r) });

      for (let i = 0; i < 5; i++) {
        wd.recordToolCall('exa_search', { query: `different-${i}` });
      }

      expect(aborts).toHaveLength(0);
      expect(wd.aborted).toBe(false);
    });

    it('should forget fingerprints outside the rolling window', () => {
      const aborts: string[] = [];
      const wd = new Watchdog(
        { ...DEFAULT_WATCHDOG_CONFIG, rollingWindowTurns: 3, duplicateThreshold: 3 },
        { onAbort: (r) => aborts.push(r) }
      );

      wd.recordToolCall('A', { q: 'x' });
      wd.recordToolCall('B', { q: 'x' });
      wd.recordToolCall('B', { q: 'x' });
      // At this point window is [A, B, B]. One more B should still be a duplicate of the last two.
      wd.recordToolCall('B', { q: 'x' });
      // Window becomes [B, B, B] — triggers abort.
      expect(aborts).toHaveLength(1);
    });

    it('should only abort once even if the same trip fires repeatedly', () => {
      const aborts: string[] = [];
      const wd = new Watchdog(DEFAULT_WATCHDOG_CONFIG, { onAbort: (r) => aborts.push(r) });

      for (let i = 0; i < 10; i++) {
        wd.recordToolCall('dup', { q: 'x' });
      }

      expect(aborts).toHaveLength(1);
    });
  });

  // H7: reaching a per-tool repeat threshold opens the diversity check. The
  // call is a loop only when its arguments are low-diversity; distinct calls
  // are exploration and the rolling-window saturation backstop remains.
  describe('per-tool-name repetition (H7 — diversity-gated soft-loop kill)', () => {
    it('should allow one tool name at the repeat limit when every argument set is distinct', () => {
      const aborts: string[] = [];
      const wd = new Watchdog(
        { ...DEFAULT_WATCHDOG_CONFIG, toolNameRepeatLimit: 5 },
        { onAbort: (r) => aborts.push(r) }
      );

      for (let i = 0; i < 5; i++) {
        wd.recordToolCall('ToolSearch', { query: `variant-${i}` });
      }

      expect(aborts).toHaveLength(0);
    });

    it('should not abort when many distinct tool names fire (no single-name dominance)', () => {
      const aborts: string[] = [];
      const wd = new Watchdog(
        { ...DEFAULT_WATCHDOG_CONFIG, toolNameRepeatLimit: 5 },
        { onAbort: (r) => aborts.push(r) }
      );

      const names = ['ToolSearch', 'exa_search', 'firecrawl_scrape', 'neo4j_read', 'getEntity'];
      for (const n of names) {
        wd.recordToolCall(n, { q: 'x' });
        wd.recordToolCall(n, { q: 'y' });
      }

      expect(aborts).toHaveLength(0);
    });

    it('should let the strict-args duplicate fire first when both thresholds would trip', () => {
      const aborts: string[] = [];
      const wd = new Watchdog(
        { ...DEFAULT_WATCHDOG_CONFIG, duplicateThreshold: 3, toolNameRepeatLimit: 8 },
        { onAbort: (r) => aborts.push(r) }
      );

      // 3× identical → strict-args trip should win
      wd.recordToolCall('exa_search', { query: 'same' });
      wd.recordToolCall('exa_search', { query: 'same' });
      wd.recordToolCall('exa_search', { query: 'same' });

      expect(aborts).toHaveLength(1);
      expect(aborts[0]).toContain('identical args');
    });

    it('should respect the rolling window for per-tool-name counts', () => {
      const aborts: string[] = [];
      const wd = new Watchdog(
        { ...DEFAULT_WATCHDOG_CONFIG, rollingWindowTurns: 5, toolNameRepeatLimit: 3 },
        { onAbort: (r) => aborts.push(r) }
      );

      // 2 ToolSearch calls early, then 4 distinct other tools — each unique
      // so neither name hits its threshold. The first ToolSearch falls out
      // of the window once the 6th call lands, leaving 1 ToolSearch + 4
      // others in the window. A final ToolSearch makes the count 2, still
      // under threshold (3). Without the rolling-window eviction we'd hit
      // 3 ToolSearch and abort.
      wd.recordToolCall('ToolSearch', { q: '1' });
      wd.recordToolCall('ToolSearch', { q: '2' });
      wd.recordToolCall('exa', { q: 'a' });
      wd.recordToolCall('firecrawl', { q: 'b' });
      wd.recordToolCall('neo4j', { q: 'c' });
      wd.recordToolCall('arxiv', { q: 'd' }); // window: [TS, TS, exa, firecrawl, neo4j, arxiv] → trims to last 5: [TS, exa, firecrawl, neo4j, arxiv]
      wd.recordToolCall('ToolSearch', { q: '3' }); // [exa, firecrawl, neo4j, arxiv, TS] → TS count = 1

      expect(aborts).toHaveLength(0);
    });
  });

  describe('empty-turn detection', () => {
    it('should abort after emptyTurnLimit consecutive turns without tool calls', () => {
      const aborts: string[] = [];
      const wd = new Watchdog({ ...DEFAULT_WATCHDOG_CONFIG, emptyTurnLimit: 3 }, { onAbort: (r) => aborts.push(r) });

      wd.recordTurn(false);
      wd.recordTurn(false);
      expect(aborts).toHaveLength(0);
      wd.recordTurn(false);

      expect(aborts).toHaveLength(1);
      expect(aborts[0]).toContain('consecutive assistant turns without a tool call');
    });

    it('should reset empty-turn streak when a tool call fires', () => {
      const aborts: string[] = [];
      const wd = new Watchdog({ ...DEFAULT_WATCHDOG_CONFIG, emptyTurnLimit: 3 }, { onAbort: (r) => aborts.push(r) });

      wd.recordTurn(false);
      wd.recordTurn(false);
      wd.recordTurn(true); // resets
      wd.recordTurn(false);
      wd.recordTurn(false);

      expect(aborts).toHaveLength(0);
    });
  });

  describe('idle detection', () => {
    it('should warn when idle exceeds idleWarnMs but not abort', () => {
      const warns: string[] = [];
      const aborts: string[] = [];
      const wd = new Watchdog(
        { ...DEFAULT_WATCHDOG_CONFIG, idleWarnMs: 10, idleAbortMs: 100_000 },
        { onWarn: (r) => warns.push(r), onAbort: (r) => aborts.push(r) }
      );

      // Immediately check idle — default lastActivityAt is "now" so nothing yet
      wd.checkIdle();
      expect(warns).toHaveLength(0);

      // Wait beyond warn threshold, stay under abort
      jest.useFakeTimers();
      jest.advanceTimersByTime(50);
      wd.checkIdle();

      expect(warns).toHaveLength(1);
      expect(aborts).toHaveLength(0);
      jest.useRealTimers();
    });

    it('should abort when idle exceeds idleAbortMs', () => {
      const aborts: string[] = [];
      const wd = new Watchdog(
        { ...DEFAULT_WATCHDOG_CONFIG, idleWarnMs: 10, idleAbortMs: 100 },
        { onAbort: (r) => aborts.push(r) }
      );

      jest.useFakeTimers();
      jest.advanceTimersByTime(200);
      wd.checkIdle();

      expect(aborts).toHaveLength(1);
      expect(aborts[0]).toContain('stream idle');
      jest.useRealTimers();
    });

    it('should reset idle timer when a tool call fires', () => {
      const aborts: string[] = [];
      const wd = new Watchdog({ ...DEFAULT_WATCHDOG_CONFIG, idleAbortMs: 200 }, { onAbort: (r) => aborts.push(r) });

      jest.useFakeTimers();
      jest.advanceTimersByTime(150);
      wd.recordToolCall('anything', { q: 1 });
      jest.advanceTimersByTime(150);
      wd.checkIdle();

      expect(aborts).toHaveLength(0);
      jest.useRealTimers();
    });
  });

  describe('recordToolResult (in-flight tool calls)', () => {
    it('should reset the idle clock when a tool result arrives', () => {
      const aborts: string[] = [];
      const wd = new Watchdog({ ...DEFAULT_WATCHDOG_CONFIG, idleAbortMs: 200 }, { onAbort: (r) => aborts.push(r) });

      jest.useFakeTimers();
      // Agent fires tool call, then tool takes 150ms (under abort threshold)
      wd.recordToolCall('slow_tool', { q: 'x' });
      jest.advanceTimersByTime(150);
      // Tool result arrives → reset idle clock
      wd.recordToolResult();
      // Then another 150ms of idle — under 200 threshold from the new lastActivityAt
      jest.advanceTimersByTime(150);
      wd.checkIdle();

      expect(aborts).toHaveLength(0);
      jest.useRealTimers();
    });

    it('should ignore recordToolResult after abort', () => {
      const aborts: string[] = [];
      const wd = new Watchdog({ ...DEFAULT_WATCHDOG_CONFIG, emptyTurnLimit: 1 }, { onAbort: (r) => aborts.push(r) });
      wd.recordTurn(false); // triggers abort
      wd.recordToolResult(); // should be a no-op
      expect(aborts).toHaveLength(1);
    });
  });

  describe('abortReason', () => {
    it('should be null before abort', () => {
      const wd = new Watchdog();
      expect(wd.abortReason).toBeNull();
    });

    it('should carry the reason after abort', () => {
      const wd = new Watchdog({ ...DEFAULT_WATCHDOG_CONFIG, emptyTurnLimit: 1 });
      wd.recordTurn(false);
      expect(wd.abortReason).not.toBeNull();
      expect(typeof wd.abortReason).toBe('string');
    });
  });

  describe('post-abort behavior', () => {
    it('should ignore recordToolCall after abort', () => {
      const aborts: string[] = [];
      const wd = new Watchdog({ ...DEFAULT_WATCHDOG_CONFIG, emptyTurnLimit: 1 }, { onAbort: (r) => aborts.push(r) });
      wd.recordTurn(false); // triggers abort
      wd.recordToolCall('anything', { q: 1 });
      wd.recordToolCall('anything', { q: 1 });
      wd.recordToolCall('anything', { q: 1 });
      expect(aborts).toHaveLength(1); // still only one abort
    });
  });
});
