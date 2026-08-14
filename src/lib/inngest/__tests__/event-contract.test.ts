/**
 * @file event-contract.test.ts
 * @description Repo-wide Inngest event contract test (P3-A, graph-foundation
 * master plan). Statically scans `src/` and asserts four invariants that make
 * the H6/M1 bug class (producer sends an event nobody handles / handler waits
 * for an event nobody sends / decorative type map drifts from reality)
 * impossible to reintroduce:
 *
 *   1. Every SENT event name has a registered handler (trigger, cancelOn or
 *      waitForEvent) OR is on the commented NOTIFICATION_ONLY allowlist.
 *   2. Every TRIGGER event name is sent somewhere OR is cron-backed (the
 *      event leg of a `[{ cron }, { event }]` double trigger) OR is on the
 *      commented EXTERNALLY_TRIGGERED allowlist.
 *   3. Every event name used anywhere (sent or handled) is declared in the
 *      `InngestEvents` map in client.ts — the map wired into the client via
 *      `EventSchemas().fromRecord<InngestEvents>()`.
 *   4. Every event declared in `InngestEvents` is actually used — no fossil
 *      declarations (e.g. the old `app/signal.detection.requested`).
 *
 * Companion to functions/__tests__/entity-sync-event-contract.test.ts (P1),
 * which pins the *payload key* contract for the entity sync events; this file
 * pins the *event name* topology for the whole app.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Allowlists — every entry needs a justification comment. Entries that stop
// being used make the test fail (stale-allowlist guard), so this list cannot
// rot silently.
// ---------------------------------------------------------------------------

/**
 * Events that are emitted purely as observability/monitoring breadcrumbs
 * (completion + failure notifications, activity-feed markers). Nobody handles
 * them in-app today; they are visible in the Inngest dashboard and are the
 * designated attach-points for future alerting.
 */
const NOTIFICATION_ONLY = new Set<string>([
  'app/agent.evaluation.failed',
  'app/build-mission.completed',
  'app/claim.batch-sync.completed',
  'app/claim.batch-sync.failed',
  'app/claim.sync.completed',
  'app/claim.sync.failed',
  'app/concept.sync.completed',
  'app/concept.sync.failed',
  'app/discovery.sweep.completed',
  'app/document.process.completed',
  'app/document.process.failed',
  'app/document.refresh.failed',
  'app/document.sync.completed',
  'app/document.sync.failed',
  'app/entity-document-link.sync.completed',
  'app/entity-document-link.sync.failed',
  'app/entity.sync.completed',
  'app/graph.init.completed',
  'app/pipeline.completed',
  'app/pipeline.failed',
  'app/placement.batch-snapshot-refresh.failed',
  'app/placement.snapshot-refresh.failed',
  'app/radar-placement.batch-sync.completed',
  'app/radar-placement.batch-sync.failed',
  'app/radar-placement.sync.completed',
  'app/radar-placement.sync.failed',
  'app/radar.graph-delete.completed',
  'app/radar.graph-delete.failed',
  'app/radar.sync.completed',
  'app/radar.sync.failed',
  'app/relation.sync.completed',
  'app/relation.sync.failed',
  'app/relations.refresh.failed',
  'app/schedule.community-reports.refresh.completed',
  // C5 emergence-detection completion — findings flow into briefings via the
  // per-finding recordAgentObservation call inside the handler, not via a
  // dedicated event handler; the completion event itself is observability-only.
  'app/schedule.emergence.detect.completed',
  'app/schedule.episodes.cleanup.completed',
  'app/schedule.linker.cycle.completed',
  'app/schedule.missions.cleanup.completed',
  'app/signal.auto-applied',
  'app/signal.auto-apply.sync.failed',
  'app/signal.expand.completed',
  'app/signal.expand.failed',
  'app/signals.cleanup.completed',
  'app/signals.cleanup.failed',
  'app/technology.batch-sync.completed',
  'app/technology.batch-sync.failed',
  'app/technology.comprehensive-research.failed',
  'app/technology.research.failed',
  'app/technology.sync.completed',
  'app/technology.sync.failed',
  'app/trl-sync.completed',
  'app/trl-sync.failed',
  'app/unified-entity.sync.failed',
]);

/**
 * Trigger events with no in-app sender. These are deliberate operator /
 * migration hooks fired via the Inngest dev UI, the Inngest REST API, or
 * standalone scripts — never from application code.
 */
const EXTERNALLY_TRIGGERED = new Set<string>([
  // Manual ops hook to re-score signals (see run-evaluation-agent.ts).
  'app/agent.evaluation.triggered',
  // Migration/backfill entry points — operator-fired, batch variants.
  'app/claim.batch-sync.requested',
  'app/document.batch-process.requested',
  'app/document.batch-sync.requested',
  'app/radar-placement.batch-sync.requested',
  // Operator one-time graph schema init (sync-assertion/reconcile).
  // ('app/full-sync.requested' left this list in DISC-006 — it now has a real
  //  in-app sender: POST /api/debug/backfill-neo4j { action: 'full-sync' }.)
  'app/graph.init.requested',
  // Manual ops hook for the bidirectional TRL sync (sync-trl-bidirectional.ts).
  'app/trl-sync.requested',
]);

// ---------------------------------------------------------------------------
// Static scanner
// ---------------------------------------------------------------------------

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..'); // <repo>/src
const FUNCTIONS_DIR = path.join('lib', 'inngest', 'functions');
const CLIENT_REL = path.join('lib', 'inngest', 'client.ts');

/** Event names look like app/domain.action[.status] — dot-separated, no extra slash. */
const EVENT_NAME_RE = /^app\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block + line comments so docstring examples don't count as usage. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

interface Usage {
  /** event name -> files that send it */
  sent: Map<string, Set<string>>;
  /** event name -> files that handle it (trigger, cancelOn, waitForEvent) */
  handled: Map<string, Set<string>>;
  /** trigger events that share a `[{ cron }, { event }]` double trigger */
  cronBacked: Set<string>;
}

function record(map: Map<string, Set<string>>, name: string, file: string): void {
  const set = map.get(name) ?? new Set<string>();
  set.add(file);
  map.set(name, set);
}

function scan(): Usage {
  const usage: Usage = { sent: new Map(), handled: new Map(), cronBacked: new Set() };

  for (const file of walk(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file);
    if (rel === CLIENT_REL) continue; // declarations handled separately
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const inFunctionsDir = rel.startsWith(FUNCTIONS_DIR + path.sep);

    // Cron-backed double triggers: [{ event: 'x' }, { cron: ... }] either order.
    if (inFunctionsDir) {
      const cronAfter = /\[\s*\{\s*event:\s*['"`](app\/[^'"`]+)['"`]\s*\}\s*,\s*\{\s*cron:/g;
      const cronBefore = /\[\s*\{\s*cron:\s*[^}]+\}\s*,\s*\{\s*event:\s*['"`](app\/[^'"`]+)['"`]/g;
      for (const re of [cronAfter, cronBefore]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(code))) usage.cronBacked.add(m[1]);
      }
    }

    // Every app/... string literal is an event reference. Classification:
    // preceded by `event:` (trigger / cancelOn / waitForEvent) => handled;
    // anything else => sent (send payload `name:`, ternary/const indirection).
    const literalRe = /['"`](app\/[^'"`\n]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = literalRe.exec(code))) {
      const name = m[1];
      if (!EVENT_NAME_RE.test(name)) continue; // route paths etc.
      const lookBehind = code.slice(Math.max(0, m.index - 20), m.index);
      const isHandlerPosition = inFunctionsDir && /event:\s*$/.test(lookBehind);
      record(isHandlerPosition ? usage.handled : usage.sent, name, rel);
    }
  }

  return usage;
}

/** Keys of the InngestEvents map in client.ts. */
function declaredEvents(): Set<string> {
  const code = stripComments(fs.readFileSync(path.join(SRC_ROOT, CLIENT_REL), 'utf8'));
  const declared = new Set<string>();
  const re = /^\s*'(app\/[^']+)':\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) declared.add(m[1]);
  return declared;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe('Inngest event contract (repo-wide static scan)', () => {
  const usage = scan();
  const declared = declaredEvents();
  const sentNames = new Set(usage.sent.keys());
  const handledNames = new Set(usage.handled.keys());

  it('sanity: the scanner sees a non-trivial event surface', () => {
    // Guards against a silent scanner regression (wrong root, bad regex)
    // that would make every other assertion pass vacuously.
    expect(sentNames.size).toBeGreaterThan(30);
    expect(handledNames.size).toBeGreaterThan(20);
    expect(declared.size).toBeGreaterThan(50);
    expect(handledNames.has('app/relation.sync.requested')).toBe(true);
    expect(sentNames.has('app/relation.sync.requested')).toBe(true);
  });

  it('every sent event has a handler or is an allowlisted notification', () => {
    const orphans = [...sentNames]
      .filter((name) => !handledNames.has(name) && !NOTIFICATION_ONLY.has(name))
      .map((name) => `${name} (sent from: ${[...usage.sent.get(name)!].join(', ')})`)
      .sort();
    expect(orphans).toEqual([]);
  });

  it('every trigger event is sent somewhere, cron-backed, or allowlisted as externally triggered', () => {
    const deadTriggers = [...handledNames]
      .filter((name) => !sentNames.has(name) && !usage.cronBacked.has(name) && !EXTERNALLY_TRIGGERED.has(name))
      .map((name) => `${name} (handled in: ${[...usage.handled.get(name)!].join(', ')})`)
      .sort();
    expect(deadTriggers).toEqual([]);
  });

  it('every used event name is declared in the InngestEvents map', () => {
    const undeclared = [...new Set([...sentNames, ...handledNames])].filter((name) => !declared.has(name)).sort();
    expect(undeclared).toEqual([]);
  });

  it('every declared event is used — no fossil declarations', () => {
    const fossils = [...declared].filter((name) => !sentNames.has(name) && !handledNames.has(name)).sort();
    expect(fossils).toEqual([]);
  });

  it('allowlists stay honest: no stale or contradictory entries', () => {
    // NOTIFICATION_ONLY entries must still be sent, and must not have grown a handler.
    const staleNotifications = [...NOTIFICATION_ONLY].filter((name) => !sentNames.has(name)).sort();
    const handledNotifications = [...NOTIFICATION_ONLY].filter((name) => handledNames.has(name)).sort();
    // EXTERNALLY_TRIGGERED entries must still be handled, and must not have grown an in-app sender.
    const staleExternal = [...EXTERNALLY_TRIGGERED].filter((name) => !handledNames.has(name)).sort();
    const sentExternal = [...EXTERNALLY_TRIGGERED].filter((name) => sentNames.has(name)).sort();
    expect({ staleNotifications, handledNotifications, staleExternal, sentExternal }).toEqual({
      staleNotifications: [],
      handledNotifications: [],
      staleExternal: [],
      sentExternal: [],
    });
  });
});
