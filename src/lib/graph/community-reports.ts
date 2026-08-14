/**
 * @file graph/community-reports.ts
 * @description F2 — async community-report overlay.
 *
 * For each Louvain community of the knowledge graph, generate an LLM summary
 * describing what the community represents (its dominant entities, relationships,
 * and themes) and store it as a `(:CommunityReport)` node. Enables "whole
 * landscape" questions that a pure local-traversal graph can't answer — the
 * load-bearing contribution of Microsoft GraphRAG.
 *
 * Reports live in the graph:
 *   (:CommunityReport {
 *     id, communityId, title, summary, memberCount, memberIds (list),
 *     algorithm: 'louvain', modularity, generatedAt, ttl
 *   })-[:ABOUT]->(:Entity)
 *
 * Refreshed nightly via the Inngest cron; queryable via the getCommunityReports
 * AI tool.
 */
import { runReadTransaction, runWriteTransaction } from './neo4j-client';
import { runLouvainCommunity } from './gds-algorithms';
import { generateStructuredContent, type GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { detectCommunityChanges } from './community-changes';
import type { CommunityChange, CommunitySnapshot } from './community-changes';
import { recordAgentObservation } from './proactive-insights';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';

const log = createLogger('graph/community-reports');

/** Best-effort: only this many changes get an AgentObservation per run. */
const MAX_CHANGE_OBSERVATIONS = 5;

const ReportSummarySchema = z.object({
  title: z.string().min(3).max(120),
  summary: z.string().min(30).max(1200),
  themes: z.array(z.string()).max(5),
});

export interface CommunityMember {
  id: string;
  name: string;
  labels: string[];
}

export interface CommunityReport {
  id: string;
  communityId: number;
  title: string;
  summary: string;
  themes: string[];
  memberCount: number;
  memberIds: string[];
  algorithm: 'louvain';
  modularity: number | null;
  generatedAt: number;
}

export interface BuildOptions {
  /** How many top-size communities to summarize in this run. Default 10. */
  topN?: number;
  /** Skip communities smaller than this (noise). Default 5. */
  minSize?: number;
  /** Skip the report-write and return the collected data (for testing). */
  dryRun?: boolean;
}

/**
 * Run Louvain + generate + persist community reports.
 *
 * Two phases:
 *   1. Run Louvain (writes gdsCommunity on every node). If Louvain is
 *      already current this is cheap.
 *   2. For each of the top-N communities by size, fetch the member entities
 *      and generate a grounded summary. Persist as :CommunityReport.
 *
 * Idempotent: running twice replaces the reports. Louvain community IDs are
 * not stable across runs (topology + non-determinism), so on each non-dryRun
 * invocation we delete any prior reports that aren't part of the current
 * top-N set. Without this the node count grows unbounded.
 */
export async function buildCommunityReports(options: BuildOptions = {}): Promise<{
  reports: CommunityReport[];
  modularity: number | null;
  /** P3-B: communities whose summary/persist failed this run (counted, never masked). */
  communitiesFailed: number;
  /** C6 — this run's membership deltas vs. the prior run's reports (empty on dryRun). */
  changes: CommunityChange[];
  /** C6 — how many `changes` became a `community-watch` AgentObservation (best-effort, top-5, suppressed on the first run). */
  changeObservationsRecorded: number;
  durationMs: number;
}> {
  const { topN = 10, minSize = 5, dryRun = false } = options;
  const t0 = Date.now();

  // Step 1 — Louvain. Cheap if recently run; writes gdsCommunity property.
  let modularity: number | null = null;
  let louvainError: Error | null = null;
  try {
    const louvain = await runLouvainCommunity({ topN: topN * 2 });
    modularity = louvain.modularity ?? null;
    log.info('Louvain complete', { communities: louvain.communityCount, modularity });
  } catch (err) {
    louvainError = err instanceof Error ? err : new Error(String(err));
    log.warn('Louvain failed; checking for existing gdsCommunity labels', {
      error: louvainError.message,
    });
  }

  // CRIT-3 unmask: warn-and-continue is only honest when there is something
  // to continue WITH. If Louvain failed and no node carries a gdsCommunity
  // label (fresh DB, or the GDS layer has never succeeded), every downstream
  // query returns empty and the run reports success while producing nothing —
  // that masked 14 consecutive nightly failures. Total failure must throw.
  if (louvainError) {
    const coverage = await runReadTransaction<{ n: number }>(
      `MATCH (n) WHERE n.gdsCommunity IS NOT NULL RETURN count(n) AS n`,
      {}
    );
    const labelled = coverage.records[0]?.n ?? 0;
    if (labelled === 0) {
      throw new Error(
        `Community reports cannot be built: Louvain failed (${louvainError.message}) ` +
          `and no prior gdsCommunity labels exist to fall back on`
      );
    }
    log.warn('Proceeding with stale gdsCommunity labels from a prior run', { labelledNodes: labelled });
  }

  // Step 2 — top-N communities by size.
  const topComms = await runReadTransaction<{ communityId: number; size: number }>(
    `MATCH (n) WHERE n.gdsCommunity IS NOT NULL
     WITH n.gdsCommunity AS communityId, count(*) AS size
     WHERE size >= toInteger($minSize)
     RETURN communityId, size ORDER BY size DESC LIMIT toInteger($topN)`,
    { minSize, topN }
  );

  // Step 2b — Read prior reports BEFORE any persist, so the membership
  // snapshot is captured before fresh reports OVERWRITE it. When a Louvain
  // community ID is reused (stable ID, different membership), a read AFTER
  // persist would return the newly-MERGEd report, causing a self-match at
  // jaccard 1.0 and silently swallowing the transition (F0 → F1).
  let prevSnapshot: CommunitySnapshot[] = [];
  if (!dryRun) {
    try {
      const prior = await runReadTransaction<{ communityId: number; title?: string; memberIds?: string[] }>(
        `MATCH (cr:CommunityReport) RETURN cr.communityId AS communityId, cr.title AS title, cr.memberIds AS memberIds`,
        {}
      );
      prevSnapshot = prior.records.map((r) => ({
        communityId: r.communityId,
        title: r.title,
        memberIds: Array.isArray(r.memberIds) ? r.memberIds : [],
      }));
    } catch (err) {
      log.warn('failed to read prior reports for membership-delta detection', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const reports: CommunityReport[] = [];
  let communitiesFailed = 0;
  for (const row of topComms.records) {
    const { communityId, size } = row;
    try {
      const members = await getMembers(communityId, 40);
      const report = await summariseCommunity(communityId, members, modularity);
      if (!report) continue;
      reports.push(report);
      if (!dryRun) {
        await persistReport(report);
      }
    } catch (err) {
      communitiesFailed++;
      log.warn('community summary failed', {
        communityId,
        size,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // P3-B fail-loud: every candidate community failed — a zero-output run must
  // not return as a success (legitimate skips via the <2-member guard don't
  // count as failures).
  if (topComms.records.length > 0 && communitiesFailed === topComms.records.length) {
    throw new Error(
      `buildCommunityReports: all ${topComms.records.length} community summaries failed — ` +
        'failing loudly instead of reporting success with no output'
    );
  }

  // Step 3 — C6 membership-delta detection. The prior membership was already
  // captured in Step 2b (before any persist), so we just use that snapshot here.
  // Gated on `!dryRun && reports.length > 0` (matching the prune's own guard):
  // if this run produced zero reports, the prune is skipped too, so nothing
  // actually changed in the graph and there is nothing honest to diff.
  let changes: CommunityChange[] = [];
  let changeObservationsRecorded = 0;
  if (!dryRun && reports.length > 0) {
    try {
      const nextSnapshot: CommunitySnapshot[] = reports.map((r) => ({
        communityId: r.communityId,
        title: r.title,
        memberIds: r.memberIds,
      }));
      changes = detectCommunityChanges(prevSnapshot, nextSnapshot);

      if (prevSnapshot.length === 0) {
        // First-run suppression (adversarially mandated): with no prior
        // reports every community in `changes` is trivially 'new' — that's
        // not a signal, it's the absence of history. Recording it would
        // spam a fresh graph's first nightly run with N "new community"
        // observations that mean nothing was actually discovered.
        log.info('community-changes: first run — no prior reports, suppressing observations', {
          changes: changes.length,
        });
      } else {
        for (const change of changes.slice(0, MAX_CHANGE_OBSERVATIONS)) {
          try {
            const target = change.kind === 'dissolved' ? change.before : change.after;
            const firstMemberId = target.memberIds[0];
            if (!firstMemberId) continue; // nothing to attach the observation to
            await recordAgentObservation({
              agentType: 'community-watch',
              observationType: 'pattern',
              title: changeTitle(change),
              summary: changeSummary(change),
              // Confidence at the service boundary is 0-1 (see
              // detect-emergence.ts) — a fixed 0.7, not the 0-100-flavored
              // "70" a first draft of this spec used.
              confidence: 0.7,
              entityId: firstMemberId,
              entityName: target.title ?? `Community ${target.communityId}`,
              entityType: 'community',
              timestamp: new Date().toISOString(),
            });
            changeObservationsRecorded++;
          } catch (perChangeError) {
            // One entity deleted between persist and this step (or any
            // other single-change hiccup) must not lose the rest of the
            // batch — best-effort, same posture as detect-emergence.ts.
            log.warn('community-changes: failed to record observation for change', {
              kind: change.kind,
              error: perChangeError instanceof Error ? perChangeError.message : String(perChangeError),
            });
          }
        }
      }
    } catch (err) {
      // The whole change-detection step is an overlay on top of the report
      // refresh, not load-bearing for it — a failure here must not fail the
      // run that already computed and persisted valid reports.
      log.warn('community-changes: failed to detect/record membership changes', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!dryRun && reports.length > 0) {
    const keepIds = reports.map((r) => r.id);
    const pruned = await runWriteTransaction<{ n: number }>(
      `MATCH (cr:CommunityReport)
       WHERE NOT cr.id IN $keepIds
       DETACH DELETE cr RETURN count(cr) AS n`,
      { keepIds }
    );
    const removed = pruned.records[0]?.n ?? 0;
    if (removed > 0) {
      log.info('Pruned stale community reports', { removed, kept: keepIds.length });
    }
  }

  return { reports, modularity, communitiesFailed, changes, changeObservationsRecorded, durationMs: Date.now() - t0 };
}

/** Human-readable title for a community-watch AgentObservation. */
function changeTitle(change: CommunityChange): string {
  switch (change.kind) {
    case 'new':
      return `New community detected: ${change.after.title ?? `Community ${change.after.communityId}`}`;
    case 'dissolved':
      return `Community dissolved: ${change.before.title ?? `Community ${change.before.communityId}`}`;
    case 'shifted':
      return `Community membership shifted: ${change.after.title ?? change.before.title ?? `Community ${change.after.communityId}`}`;
  }
}

/** Human-readable summary for a community-watch AgentObservation. */
function changeSummary(change: CommunityChange): string {
  switch (change.kind) {
    case 'new':
      return `A new community of ${change.after.memberIds.length} members emerged in the latest Louvain run.`;
    case 'dissolved':
      return `A ${change.before.memberIds.length}-member community no longer appears in the latest Louvain run.`;
    case 'shifted':
      return (
        `Membership shifted (Jaccard similarity ${change.jaccard.toFixed(2)}): ` +
        `+${change.added.length} new members, -${change.removed.length} departed members.`
      );
  }
}

async function getMembers(communityId: number, limit: number): Promise<CommunityMember[]> {
  const rows = await runReadTransaction<{ id: string; name: string; labels: string[] }>(
    `MATCH (n) WHERE n.gdsCommunity = toInteger($communityId)
     RETURN n.id AS id, coalesce(n.name, n.title, n.id) AS name, labels(n) AS labels
     ORDER BY coalesce(n.name, n.title, '') LIMIT toInteger($limit)`,
    { communityId, limit }
  );
  return rows.records.map((r) => ({
    id: r.id,
    name: r.name,
    labels: Array.isArray(r.labels) ? r.labels : [],
  }));
}

async function summariseCommunity(
  communityId: number,
  members: CommunityMember[],
  modularity: number | null
): Promise<CommunityReport | null> {
  if (members.length < 2) return null;

  const sample = members.slice(0, 30).map((m) => `- ${m.name} [${(m.labels[1] ?? m.labels[0] ?? '?').slice(0, 20)}]`);

  const prompt = `You are summarising a community of entities from a technology radar
knowledge graph. Below is a sample of ${members.length} members.

Members (up to 30 shown):
${sample.join('\n')}

Produce a tight summary of what this community represents:
  title      — 3–10 words naming the community's dominant theme
  summary    — 3–5 sentences describing what ties these entities together,
               what questions a user might ask about this community, and any
               notable entities to watch
  themes     — up to 5 one-word or short-phrase themes (e.g. "open-source",
               "foundation models", "compute scaling")

Ground your answer in the actual member names — do not invent entities.
Return ONLY the JSON object, no preamble or markdown.`;

  const parsed = await generateStructuredContent(prompt, ReportSummarySchema, {
    model: geminiTextModel() as GeminiModel,
    temperature: 0.2,
    useGoogleSearch: false, // members are ours; grounding not needed
  });

  return {
    id: `community-report-${communityId}`,
    communityId,
    title: parsed.title,
    summary: parsed.summary,
    themes: parsed.themes,
    memberCount: members.length,
    memberIds: members.map((m) => m.id),
    algorithm: 'louvain',
    modularity,
    generatedAt: Date.now(),
  };
}

async function persistReport(report: CommunityReport): Promise<void> {
  await runWriteTransaction(
    `MERGE (cr:CommunityReport {id: $id})
     SET cr.communityId = $communityId,
         cr.title = $title,
         cr.summary = $summary,
         cr.themes = $themes,
         cr.memberCount = $memberCount,
         cr.memberIds = $memberIds,
         cr.algorithm = $algorithm,
         cr.modularity = $modularity,
         cr.generatedAt = $generatedAt
     WITH cr
     OPTIONAL MATCH (cr)-[old:ABOUT]->() DELETE old
     WITH cr
     UNWIND $memberIds AS mid
     MATCH (m {id: mid})
     MERGE (cr)-[:ABOUT]->(m)`,
    {
      id: report.id,
      communityId: report.communityId,
      title: report.title,
      summary: report.summary,
      themes: report.themes,
      memberCount: report.memberCount,
      memberIds: report.memberIds,
      algorithm: report.algorithm,
      modularity: report.modularity,
      generatedAt: report.generatedAt,
    }
  );
}

/**
 * Return the K best-matching community reports for a free-text query.
 *
 * Match strategy (simple, effective): score each report by substring
 * overlap between the query and the report's title + summary + themes,
 * return top-K. A follow-up can add embedding-based ranking once the
 * community-report corpus is big enough for it to matter.
 */
export async function queryCommunityReports(query: string, k = 3): Promise<Array<CommunityReport & { score: number }>> {
  const rows = await runReadTransaction<{
    id: string;
    communityId: number;
    title: string;
    summary: string;
    themes: string[];
    memberCount: number;
    memberIds: string[];
    modularity: number | null;
    generatedAt: number;
  }>(
    `MATCH (cr:CommunityReport) RETURN
       cr.id AS id, cr.communityId AS communityId, cr.title AS title, cr.summary AS summary,
       cr.themes AS themes, cr.memberCount AS memberCount, cr.memberIds AS memberIds,
       cr.modularity AS modularity, cr.generatedAt AS generatedAt`,
    {}
  );

  const needle = query.toLowerCase();
  const scored = rows.records.map((r) => {
    const hay = `${r.title}\n${r.summary}\n${(r.themes ?? []).join(' ')}`.toLowerCase();
    const score = hay.split(needle).length - 1;
    return {
      ...r,
      score,
      algorithm: 'louvain' as const,
      themes: Array.isArray(r.themes) ? r.themes : [],
      memberIds: Array.isArray(r.memberIds) ? r.memberIds : [],
    };
  });
  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.memberCount - a.memberCount)
    .slice(0, k);
}
