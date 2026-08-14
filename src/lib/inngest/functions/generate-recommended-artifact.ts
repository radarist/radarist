/**
 * @file inngest/functions/generate-recommended-artifact.ts
 * @description Execute-on-approve for the "recommendation" inbox kind. When a human
 * approves a proposedArtifact, this job produces the actual artifact and records the
 * output back on the proposal (generationStatus + outputRef):
 *   - report      → durable execution mission + AI HTML → upsertReportBySlot (one
 *                   private report per mission slot, replay-convergent — REPORT-005)
 *   - infographic → AI generates a real image             → createVisualization
 *   - research    → create a Document + dispatch deep-research  → (fills async)
 *
 * The core (`runArtifactGeneration`) is exported separately so it is unit-testable
 * without the Inngest runtime.
 */
import { inngest } from '@/lib/inngest/client';
import { getEntityUrl } from '@/lib/entity-links';
import { createLogger } from '@/lib/logger';
import {
  getProposedArtifactById,
  updateProposedArtifact,
  ensureExecutionMission,
} from '@/lib/proposed-artifacts-admin';
import { updateMission } from '@/lib/missions';
import { upsertReportBySlot, updateReport, getReportOwnedBy } from '@/lib/reports';
import { dispatchDeepResearchDocument } from '@/lib/deep-research-document-admin';
import { generateContent } from '@/lib/ai/client';
import { geminiImageModel } from '@/lib/ai/model-config';
import type { ProposedArtifact } from '@/lib/schemas/proposed-artifact';
import { MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH, MAX_VISUALIZATION_TITLE_LENGTH } from '@/lib/schemas/visualization';

const log = createLogger('inngest/generate-recommended-artifact');

/** A refresh must keep ≥ this fraction of the original's depth, or the original is preserved. */
const QUALITY_FLOOR = 0.9;

/** A structure-weighted "depth" score — the before/after benchmark the quality gate compares. */
function richness(html: string): number {
  const n = (re: RegExp) => (html.match(re) || []).length;
  return html.length + n(/<h[1-6][ >]/gi) * 300 + n(/<li[ >]/gi) * 40 + n(/<p[ >]/gi) * 120 + n(/<table[ >]/gi) * 400;
}

/** UPDATE prompt — feed the ORIGINAL so the refresh enhances it instead of regenerating thinner. */
function refreshPrompt(p: ProposedArtifact, originalHtml: string): string {
  if (!originalHtml) return reportPrompt(p); // no original to preserve → behave like a create
  return `You are REFRESHING an existing report. Here is its CURRENT full HTML:

${originalHtml}

Produce an UPDATED version that:
- PRESERVES every existing section, table, list, and all depth/detail — never remove, summarize, or shorten existing content;
- ADDS the latest developments and any newer data on the topic, woven into the relevant sections;
- keeps the same visual style and structure.
The result MUST be at least as rich and long as the original. Return ONLY the full self-contained HTML, starting with <!DOCTYPE html>.`;
}

function reportPrompt(p: ProposedArtifact): string {
  const about = p.scope?.query || p.scope?.entityIds?.join(', ') || p.title;
  return `Produce a single self-contained HTML document (inline <style>, no external assets) — a clean, well-structured analytical REPORT: an executive summary, 3-5 sections with headings, and a takeaways list.
Title: "${p.title}".
Topic / scope: ${about}.
Why it matters: ${p.rationale ?? 'horizon-scanning for the innovation radar'}.
Return ONLY the HTML, starting with <!DOCTYPE html>. Keep it professional and board-ready.`;
}

/**
 * Generate the artifact for an APPROVED proposal. No-op unless the proposal is
 * approved + generating. On success records outputRef + generationStatus; on failure
 * records 'failed' + the error, then rethrows so the Inngest step surfaces it.
 *
 * SEC-011: `requestedBy` (the event's userId) is AUDIT DATA ONLY — execution
 * ownership derives exclusively from the persisted proposal's `sourceUserId`.
 * A proposal without an owner fails loudly instead of running as 'system'.
 */
export async function runArtifactGeneration(proposedArtifactId: string, requestedBy: string): Promise<void> {
  const proposal = await getProposedArtifactById(proposedArtifactId);
  if (!proposal) {
    log.warn('artifact generation: proposal not found', { proposedArtifactId });
    return;
  }
  if (proposal.status !== 'approved') {
    log.warn('artifact generation: proposal not approved — skipping', { proposedArtifactId, status: proposal.status });
    return;
  }
  // REPORT-005: replay guard — a re-delivered event for an already-generated
  // proposal must not regenerate (and must not spend AI budget again).
  if (proposal.generationStatus === 'ready' && proposal.outputRef) {
    log.info('artifact generation: output already recorded — replay is a no-op', {
      proposedArtifactId,
      outputId: proposal.outputRef.id,
    });
    return;
  }
  // Research fills asynchronously: the proposal stays 'generating' with a
  // document outputRef for the whole deep-research window, so the ready-guard
  // above never covers it. A replayed event in that window must not dispatch a
  // second (expensive) deep-research document.
  if (
    proposal.artifactKind === 'research' &&
    proposal.generationStatus === 'generating' &&
    proposal.outputRef?.type === 'document'
  ) {
    log.info('artifact generation: deep-research already dispatched — replay is a no-op', {
      proposedArtifactId,
      documentId: proposal.outputRef.id,
    });
    return;
  }

  const owner = proposal.sourceUserId;
  if (!owner) {
    await updateProposedArtifact(proposedArtifactId, {
      generationStatus: 'failed',
      generationError: 'This recommendation has no owner, so it cannot be executed.',
    });
    log.warn('artifact generation refused — ownerless proposal', { proposedArtifactId, requestedBy });
    return;
  }

  // REPORT-005: the durable execution identity for the CREATE-report path;
  // tracked here so the outer catch can mark the mission failed too.
  let executionMissionId: string | undefined;
  try {
    if (proposal.artifactKind === 'infographic') {
      // A REAL visual infographic (Nano Banana image) → saved to the Visualizations gallery.
      const about = proposal.scope?.query || proposal.scope?.entityIds?.join(', ') || proposal.title;
      const { generateInfographic } = await import('@/lib/ai/image-client');
      const { createVisualization, buildLearnedStyleFragment } = await import('@/lib/visualizations');
      const prompt = `A clean, professional infographic titled "${proposal.title}" about ${about}. ${proposal.rationale ?? ''}`;
      const storageObjectName = `artifact-${proposedArtifactId}`;
      const storageObjectPath = `visualizations/${owner}/${storageObjectName}`;
      // US-1: read the like/dislike loop back into generation. Fail-open — a broken
      // lookup must never block infographic generation for a recommended artifact.
      let learnedStyleFragment: string | undefined;
      try {
        learnedStyleFragment = await buildLearnedStyleFragment();
      } catch (error) {
        log.warn('learned-style fragment lookup failed — generating without it', {
          proposedArtifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const img = await generateInfographic({
        prompt,
        style: 'professional',
        aspectRatio: '16:9',
        userId: owner,
        pathPrefix: 'visualizations',
        filename: storageObjectName,
        brandStyle: learnedStyleFragment,
      });
      if (!img.success || !img.url) throw new Error(img.error ?? 'infographic image generation failed');
      const visualizationTitle = proposal.title.slice(0, MAX_VISUALIZATION_TITLE_LENGTH);
      const visualizationDescription = (proposal.rationale ?? proposal.title).slice(
        0,
        MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH
      );
      const viz = await createVisualization({
        title: visualizationTitle,
        prompt,
        refinedPrompt: prompt,
        imageUrl: img.url,
        thumbnailUrl: img.url,
        storageObjectPath,
        mimeType: (img.mimeType as 'image/png' | 'image/jpeg') ?? 'image/png',
        style: 'professional',
        dataSnapshot: { entities: [], description: visualizationDescription },
        userId: owner,
        createdBy: owner,
        metadata: {
          model: geminiImageModel(),
          width: img.width ?? 0,
          height: img.height ?? 0,
          sizeBytes: img.sizeBytes ?? 0,
        },
        ...(learnedStyleFragment ? { appliedStyleFragment: learnedStyleFragment } : {}),
      });
      await updateProposedArtifact(proposedArtifactId, {
        generationStatus: 'ready',
        outputRef: { type: 'visualization', id: viz.id, url: `/infographics/${viz.id}` },
      });
      log.info('artifact generated (infographic)', { proposedArtifactId, vizId: viz.id });
      return;
    }

    if (proposal.artifactKind === 'report') {
      const snapshotAt = new Date().toISOString();

      // UPDATE an existing report — ENHANCE it (feed the original so depth is preserved),
      // and NEVER replace it with a materially thinner version (the quality gate).
      if (proposal.updateOf?.type === 'report') {
        // REPORT-002: a generated report is stored `shared: false`, so the
        // owner's link must be the authenticated private route. Any
        // `/share/report/...` value stored by an earlier generation is
        // normalized away rather than propagated — following it renders
        // "Report Not Shared". Sharing stays a separate explicit approval.
        const reportUrl = `/reports/${proposal.updateOf.id}`;
        // SEC-009: read through the owner boundary. This path reads the target
        // report's FULL html (and ships it to Gemini in refreshPrompt) and then
        // rewrites it in place — without this scope it would do both for any
        // report id the proposal names, including another user's or an
        // ownerless legacy one. Absent/foreign/ownerless all resolve to null.
        const existing = await getReportOwnedBy(proposal.updateOf.id, owner);
        if (!existing) {
          await updateProposedArtifact(proposedArtifactId, {
            generationStatus: 'failed',
            generationError: 'The report this recommendation targets is no longer available to you.',
          });
          log.warn('artifact refresh denied — target report missing or not owned', {
            proposedArtifactId,
            reportId: proposal.updateOf.id,
          });
          return;
        }
        const originalHtml = existing.html ?? '';
        const newHtml = await generateContent(refreshPrompt(proposal, originalHtml), { temperature: 0.4 });

        // Quality gate: a refresh must preserve (or improve) the original's depth.
        if (originalHtml) {
          const before = richness(originalHtml);
          const after = richness(newHtml);
          if (after < before * QUALITY_FLOOR) {
            const ratio = before > 0 ? Math.round((after / before) * 100) : 0;
            await updateProposedArtifact(proposedArtifactId, {
              generationStatus: 'failed',
              generationError: `Kept the original — the refreshed version was only ${ratio}% of its depth (would have lost content). The report was NOT changed.`,
              outputRef: { type: 'report', id: proposal.updateOf.id, url: reportUrl },
            });
            log.warn('refresh rejected by quality gate — original preserved', {
              proposedArtifactId,
              reportId: proposal.updateOf.id,
              ratio,
            });
            return;
          }
        }

        await updateReport(
          proposal.updateOf.id,
          {
            html: newHtml,
            metadata: { description: proposal.rationale || proposal.title, dataSnapshotAt: snapshotAt },
          },
          // DISC-014: attribute the captured version to the recommendation
          // engine. SEC-009: ownership is re-checked INSIDE the update
          // transaction, so the read above cannot go stale between check and
          // write.
          { savedBy: 'agent:artifact-recommender', requireOwnerId: owner }
        );
        await updateProposedArtifact(proposedArtifactId, {
          generationStatus: 'ready',
          outputRef: { type: 'report', id: proposal.updateOf.id, url: reportUrl },
        });
        log.info('artifact UPDATED (report, passed quality gate)', {
          proposedArtifactId,
          reportId: proposal.updateOf.id,
        });
        return;
      }

      // REPORT-005: mint the durable owned execution identity BEFORE generation.
      // Replayed events reuse the same mission; upsert-by-slot below then
      // converges on the same single report instead of duplicating.
      executionMissionId = await ensureExecutionMission(proposedArtifactId, {
        prompt: reportPrompt(proposal),
        agent: 'artifact-recommender',
      });
      await updateMission(executionMissionId, { status: 'running', progress: 10 });

      const html = await generateContent(reportPrompt(proposal), { temperature: 0.5 });
      // Narrow the upsert's documented non-atomic (missionId, slotName) window:
      // if a concurrent execution finished while we were generating, converge
      // on its output instead of racing the slot query→insert. The transition-
      // gated dispatch in the approve route makes concurrency itself rare;
      // this recheck keeps a duplicate delivery from doubling the report.
      const latest = await getProposedArtifactById(proposedArtifactId);
      if (latest?.generationStatus === 'ready' && latest.outputRef?.type === 'report') {
        // A concurrent execution won. This run may have re-marked the SHARED
        // mission 'running' after the winner completed it, so re-terminalize
        // instead of leaving a delivered mission stranded at running/10.
        await updateMission(executionMissionId, {
          status: 'completed',
          progress: 100,
          reportId: latest.outputRef.id,
          reportIds: [latest.outputRef.id],
          outcome: 'delivered',
          result: `Generated report "${proposal.title}" from an approved recommendation.`,
        }).catch(() => undefined);
        log.info('artifact generation: concurrent execution already recorded output — skipping publish', {
          proposedArtifactId,
          outputId: latest.outputRef.id,
        });
        return;
      }
      const result = await upsertReportBySlot({
        missionId: executionMissionId,
        slotName: 'main',
        title: proposal.title,
        html,
        description: proposal.rationale || proposal.title,
        createdBy: 'agent',
        agentType: 'artifact-recommender',
        ownerId: owner,
        entityIds: proposal.scope?.entityIds ?? [],
        savedBy: 'agent:artifact-recommender',
      });
      await updateMission(executionMissionId, {
        status: 'completed',
        progress: 100,
        reportId: result.reportId,
        reportIds: [result.reportId],
        outcome: 'delivered',
        result: `Generated report "${proposal.title}" from an approved recommendation.`,
      });
      await updateProposedArtifact(proposedArtifactId, {
        generationStatus: 'ready',
        // REPORT-002: private route — a freshly generated report is not shared.
        // `result.reportUrl` IS that authenticated /reports/{id} route.
        outputRef: { type: 'report', id: result.reportId, url: result.reportUrl },
      });
      log.info('artifact generated (report)', {
        proposedArtifactId,
        reportId: result.reportId,
        missionId: executionMissionId,
        kind: proposal.artifactKind,
      });
      return;
    }

    if (proposal.artifactKind === 'research') {
      const query = proposal.scope?.query || proposal.title;
      // AI-021: shared generated-document contract — truthful `processing`
      // state and verified dispatch. A dispatch failure throws, and the catch
      // below marks the recommendation `failed` instead of leaving a
      // generating artifact pointing at a dead document.
      const doc = await dispatchDeepResearchDocument({
        query,
        userId: owner,
        title: proposal.title,
        tags: proposal.matchedTopics ?? [],
        proposedArtifactId,
        logPrefix: '[ArtifactGen]',
      });
      // The deep-research job fills the document asynchronously — link it now, keep generating.
      // Deep link into the library sheet (there is no /documents/[id] route) —
      // getEntityUrl carries the page-specific sheet param (?document=).
      await updateProposedArtifact(proposedArtifactId, {
        generationStatus: 'generating',
        outputRef: { type: 'document', id: doc.id, url: getEntityUrl('document', doc.id) ?? '/library/documents' },
      });
      log.info('artifact dispatched (research)', { proposedArtifactId, documentId: doc.id });
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateProposedArtifact(proposedArtifactId, { generationStatus: 'failed', generationError: message }).catch(
      () => undefined
    );
    // Failure truth: the durable execution mission must not linger as
    // pending/running when its generation failed. Best-effort — the proposal's
    // failed state above is the primary record.
    if (executionMissionId) {
      await updateMission(executionMissionId, {
        status: 'failed',
        result: `Recommendation generation failed: ${message}`,
      }).catch(() => undefined);
    }
    log.error('artifact generation failed', error instanceof Error ? error : new Error(message), {
      proposedArtifactId,
    });
    throw error;
  }
}

export const generateRecommendedArtifactJob = inngest.createFunction(
  { id: 'generate-recommended-artifact', name: 'Generate Recommended Artifact', retries: 2 },
  { event: 'app/artifact.generation.requested' },
  async ({ event, step }) => {
    const { proposedArtifactId, userId } = event.data;
    await step.run('generate', () => runArtifactGeneration(proposedArtifactId, userId));
    return { proposedArtifactId };
  }
);
