// ---------------------------------------------------------------------------
// Watchdog — detects runaway loops, silent hangs, and spinning agents
// ---------------------------------------------------------------------------
//
// Three independent heuristics, any one of which aborts the mission early:
//
//   1. Tool-call fingerprint repetition — if the same tool_name + args hash
//      fires duplicateThreshold× within the rolling window, the agent is
//      stuck re-issuing the same call.
//
//   2. Stream idle — if the gap between turns exceeds idleAbortMs, the
//      SDK stream or a downstream tool is hung. Warn at idleWarnMs, abort
//      at idleAbortMs.
//
//   3. Empty turns — if emptyTurnLimit consecutive assistant turns contain
//      no tool call, the agent is spinning in its own reasoning without
//      making progress.
//
// Abort propagation: the orchestrator loop polls `.aborted` after each
// assistant message. When true, it throws so the Inngest handler can
// promote the last checkpoint to `result` with partial=true.

import { createHash } from 'crypto';

export interface WatchdogConfig {
  /** How many duplicates of the same fingerprint trigger an abort. */
  duplicateThreshold: number;
  /** How many recent fingerprints to keep in the rolling window. */
  rollingWindowTurns: number;
  /**
   * H7: How many times a single tool *name* can fire within the rolling
   * window before we test it for a soft loop. Reaching this count is a
   * *suspicion*, not a verdict — the abort only fires when the calls are
   * also low-diversity (see softLoopDiversityRatio). Set higher than
   * duplicateThreshold so strict duplicates still fire first.
   */
  toolNameRepeatLimit: number;
  /**
   * H7 gate: the fraction of calls to one tool that must carry DISTINCT
   * arguments for the run to count as exploration rather than a loop.
   *
   * Why this exists: counting tool-name repetition alone conflates two
   * opposite behaviours. An agent issuing N calls with N different argument
   * sets is covering different ground; an agent rephrasing the same request
   * is spinning. Argument diversity is the signal that separates them, and
   * the strict-args guard above already catches exact repeats.
   *
   * Every false-abort shape covered by toolNameRepeatLimitByTool below
   * (renderDiagram 8→20, gemini-grounding 8→25, searchKnowledgeGraph 8→16,
   * and eight distinct ToolSearch `select:` batches) is a high-diversity run
   * that name-only repetition can misread as a loop. Gating on
   * diversity fixes the class instead of the instances, so the per-tool map
   * is now a tightening knob rather than the mechanism keeping legitimate
   * work alive.
   */
  softLoopDiversityRatio: number;
  /**
   * Absolute backstop, independent of diversity: the fraction of the rolling
   * window a SINGLE tool may occupy. An agent whose recent history is
   * essentially one tool is not making progress even if every call differs,
   * so this still stops a pathological all-search run. Breadth of legitimate
   * work is governed by the tool-call and cost budgets, not by this hook.
   */
  windowSaturationRatio: number;
  /**
   * Per-tool overrides for the H7 limit. Some tools fire legitimately many
   * times in a row — e.g., renderDiagram once per section in a multi-chart
   * report can legitimately exceed the global limit of eight calls.
   * Map a tool name to its own threshold; falls back to toolNameRepeatLimit
   * when not present. Lower bounds are valid too (e.g., to make ToolSearch
   * stricter).
   */
  toolNameRepeatLimitByTool?: Record<string, number>;
  /** Idle gap between turns that triggers a warn (ms). */
  idleWarnMs: number;
  /** Idle gap that triggers an abort (ms). */
  idleAbortMs: number;
  /** Consecutive assistant turns without a tool call that trigger abort. */
  emptyTurnLimit: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  duplicateThreshold: 3,
  rollingWindowTurns: 20,
  // 8× of a single tool name in the last 20 turns = the agent is spending
  // 40% of its turns on one operation without making progress. Tuned so
  // legitimate iterative search (e.g. exa_search → refine → exa_search)
  // doesn't false-abort but a runaway ToolSearch loop does.
  toolNameRepeatLimit: 8,
  // 60%: eight calls carrying five or more distinct argument sets read as
  // exploration; eight calls sharing four or fewer read as rephrasing the
  // same request. Exact repeats are caught earlier by duplicateThreshold.
  softLoopDiversityRatio: 0.6,
  // 90% of the window on one tool means nothing else is happening.
  windowSaturationRatio: 0.9,
  // Per-tool overrides: some tools fire legitimately many times in a row.
  // Multi-section reports legitimately render one diagram per section plus a
  // revision pass. Image-generation paths can iterate similarly. Each entry
  // is the per-tool ceiling within
  // rollingWindowTurns; the base limit still applies to tools not listed.
  toolNameRepeatLimitByTool: {
    'mcp__super-graph__renderDiagram': 20,
    'mcp__gemini-image__generate_image': 15,
    'mcp__impulse-reports__generateVisualization': 15,
    'mcp__impulse-reports__generateInfographic': 15,
    // Research-heavy missions legitimately fire many search queries across
    // foundational theory + modern empirical + practitioner cases. A broad
    // inquiry can exceed eight grounding calls while covering Pinchot/Burgelman/
    // Kanter, ambidextrous theory, modern empirical outcomes, failure
    // modes, and 4-5 industry cases. Each is a defensibly different
    // search. Same shape as Bug F — raise the per-tool ceiling for
    // surfaces where iterative search is the right behavior.
    'mcp__gemini-grounding__search_with_grounding': 25,
    mcp__exa__web_search_exa: 25,
    mcp__exa__web_fetch_exa: 20,
    mcp__firecrawl__firecrawl_scrape: 20,
    mcp__firecrawl__firecrawl_search: 20,
    mcp__arxiv__search_papers: 20,
    'mcp__gemini-research__start_research': 10,
    // In-tree knowledge-graph search: a cross-silo strategist legitimately runs
    // many DISTINCT graph searches (one query per silo/angle), such as separate
    // autonomous-workflow, security-guardrail, and agent-protocol queries. The
    // strict-args duplicate guard (3×) still catches a true identical-query loop.
    // 16 (double the old global-8) is generous for multi-silo research yet still
    // backstops a pathological all-search run within the 20-turn window (a cap
    // >= rollingWindowTurns would silently disable H7 for this tool entirely).
    'mcp__impulse-graph__searchKnowledgeGraph': 16,
    'mcp__impulse-graph__getCommunityReports': 15,
    'mcp__impulse-graph__getGapAnalysis': 15,
    'mcp__impulse-graph__findPaths': 15,
  },
  // Large MCP tool calls (e.g. a multi-minute firecrawl_crawl or an impulse-graph
  // aggregate over a large graph) can legitimately take 5-8 min for the stdio
  // round-trip. The watchdog must tolerate that without false-aborting. Use
  // recordToolResult on tool_use_summary messages so the idle clock resets
  // when a tool actually returns. (publishReport is fast — HTML stays on FS.)
  idleWarnMs: 240_000, // 4 min
  idleAbortMs: 600_000, // 10 min
  emptyTurnLimit: 5,
};

export interface WatchdogEvents {
  onAbort?: (reason: string) => void;
  onWarn?: (reason: string) => void;
}

export class Watchdog {
  private fingerprints: string[] = [];
  private toolNames: string[] = [];
  private lastActivityAt = Date.now();
  private emptyTurnStreak = 0;
  private _aborted = false;
  private _abortReason: string | null = null;
  private warnedIdle = false;

  constructor(
    private config: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
    private events: WatchdogEvents = {}
  ) {}

  /**
   * Record a single tool-use call. Tracks fingerprint repetition and bumps
   * the activity timestamp so the idle watchdog resets.
   */
  recordToolCall(toolName: string, args: unknown): void {
    if (this._aborted) return;

    const fp = this.fingerprint(toolName, args);
    this.fingerprints.push(fp);
    if (this.fingerprints.length > this.config.rollingWindowTurns) {
      this.fingerprints.shift();
    }

    // Track tool names independently from fingerprints so the H7 per-name
    // counter and the strict-args duplicate counter share the same window
    // size but have independent thresholds.
    this.toolNames.push(toolName);
    if (this.toolNames.length > this.config.rollingWindowTurns) {
      this.toolNames.shift();
    }

    // Identical args alone are NOT a loop. A staged publication workflow may
    // legitimately repeat publishReport after intervening design and critique
    // work. A true loop repeats a call without accomplishing anything between
    // attempts, so abort only when repeats are consecutive.
    const dupCount = this.fingerprints.filter((f) => f === fp).length;
    if (dupCount >= this.config.duplicateThreshold) {
      const positions: number[] = [];
      this.fingerprints.forEach((f, i) => {
        if (f === fp) positions.push(i);
      });
      const recent = positions.slice(-this.config.duplicateThreshold);
      const span = this.fingerprints.slice(recent[0], recent[recent.length - 1] + 1);
      const intervening = span.filter((f) => f !== fp).length;
      if (intervening === 0) {
        this.abort(
          `tool ${toolName} with identical args fired ${dupCount}× consecutively in the last ` +
            `${this.config.rollingWindowTurns} turns, with no other tool call in between — loop detected`
        );
        return;
      }
    }

    // H7: per-tool-name soft loop, gated on argument diversity. Reaching the
    // repeat limit only opens the question; the verdict comes from how much
    // of that repetition carries genuinely different arguments. A rephrasing
    // loop collapses to a few distinct fingerprints, while iterative research
    // keeps producing new ones.
    const nameCount = this.toolNames.filter((n) => n === toolName).length;
    const limit = this.config.toolNameRepeatLimitByTool?.[toolName] ?? this.config.toolNameRepeatLimit;
    if (nameCount >= limit) {
      const distinctArgs = new Set(
        this.toolNames.map((name, index) => (name === toolName ? this.fingerprints[index] : null)).filter(Boolean)
      ).size;
      const requiredDistinct = Math.ceil(nameCount * this.config.softLoopDiversityRatio);
      if (distinctArgs < requiredDistinct) {
        this.abort(
          `tool ${toolName} fired ${nameCount}× in last ${this.config.rollingWindowTurns} turns with only ` +
            `${distinctArgs} distinct argument set(s) (needed ${requiredDistinct}) — soft loop detected`
        );
        return;
      }
    }

    // Saturation backstop: one tool monopolising the window is not progress
    // even when every call differs. Independent of diversity by design.
    const saturationLimit = Math.ceil(this.config.rollingWindowTurns * this.config.windowSaturationRatio);
    if (nameCount >= saturationLimit) {
      this.abort(
        `tool ${toolName} occupied ${nameCount} of the last ${this.config.rollingWindowTurns} turns — ` +
          `window saturated, no other progress`
      );
      return;
    }

    this.lastActivityAt = Date.now();
    this.warnedIdle = false;
  }

  /**
   * Record that a tool call returned (tool_use_summary message observed).
   * Resets the idle clock so a legitimately slow tool doesn't false-abort.
   * Slow MCP round-trips (e.g. a multi-minute firecrawl_crawl or a heavy
   * impulse-graph aggregate) can keep the stream "silent" from the
   * assistant's perspective for minutes — this is expected, not a hang.
   */
  recordToolResult(): void {
    if (this._aborted) return;
    this.lastActivityAt = Date.now();
    this.warnedIdle = false;
  }

  /**
   * Record that an assistant turn completed. `hadToolCall` must reflect
   * whether the turn's content blocks included at least one tool_use.
   * Empty turns accumulate toward the empty-turn abort threshold.
   */
  recordTurn(hadToolCall: boolean): void {
    if (this._aborted) return;

    this.lastActivityAt = Date.now();
    this.warnedIdle = false;

    if (hadToolCall) {
      this.emptyTurnStreak = 0;
      return;
    }

    this.emptyTurnStreak += 1;
    if (this.emptyTurnStreak >= this.config.emptyTurnLimit) {
      this.abort(`${this.emptyTurnStreak} consecutive assistant turns without a tool call — agent spinning`);
    }
  }

  /**
   * Check whether the stream has been idle too long. Called by an external
   * setInterval from the orchestrator. Does not reset state; just reports.
   */
  checkIdle(): void {
    if (this._aborted) return;
    const idle = Date.now() - this.lastActivityAt;

    if (idle >= this.config.idleAbortMs) {
      this.abort(
        `stream idle for ${Math.round(idle / 1000)}s — exceeded ${Math.round(this.config.idleAbortMs / 1000)}s abort threshold`
      );
      return;
    }

    if (idle >= this.config.idleWarnMs && !this.warnedIdle) {
      this.warnedIdle = true;
      if (this.events.onWarn) {
        this.events.onWarn(`stream idle for ${Math.round(idle / 1000)}s — approaching abort threshold`);
      }
    }
  }

  /** True once any heuristic has decided the mission should stop. */
  get aborted(): boolean {
    return this._aborted;
  }

  /** Human-readable reason the watchdog aborted; null if not aborted. */
  get abortReason(): string | null {
    return this._abortReason;
  }

  /**
   * External-trigger abort. Used by the orchestrator's cancel-check loop to
   * stop a mission whose status was flipped to non-running from outside
   * (UI cancel button, manual kill scripts, mission-failed Firestore writes).
   * Goes through the same `abort()` path as the heuristic trips so the
   * orchestrator's catch-block cost-capture + checkpoint-promotion flow runs.
   */
  forceAbort(reason: string): void {
    this.abort(reason);
  }

  private abort(reason: string): void {
    if (this._aborted) return; // only fire once
    this._aborted = true;
    this._abortReason = reason;
    if (this.events.onAbort) {
      this.events.onAbort(reason);
    }
  }

  private fingerprint(toolName: string, args: unknown): string {
    const argStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    return createHash('sha256').update(`${toolName}:${argStr}`).digest('hex').slice(0, 16);
  }
}
