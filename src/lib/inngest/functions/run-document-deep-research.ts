/**
 * @file lib/inngest/functions/run-document-deep-research.ts
 * @description Inngest background job for Gemini Deep Research document creation.
 *
 * Uses the Interactions API to start a deep research task that autonomously
 * browses the web for 1-5+ minutes, then saves the result as a markdown
 * document in the library.
 *
 * **Execution Flow:**
 * 1. Start deep research via Interactions API → get interactionId
 * 2. Poll for completion (15s intervals, max ~15 min)
 * 3. Upload result markdown to Firebase Storage
 * 4. Update document status + metadata
 * 5. Process document (chunk for search/citations)
 *
 * **Trigger:** `app/document.deep-research.requested`
 * **Timeout:** 12 minutes (research can take 1-5+ min + processing)
 * **Retries:** 2 attempts
 *
 * @author Radarist Team
 * @created 2026-02-27
 */

import { inngest } from '../client';
import { captureDurableInstantMs, deriveDurableTimingMs } from '../durable-duration';
import { declareDomainOutcome } from '../domain-outcome';
import { startDeepResearch, pollDeepResearch } from '@/lib/ai/deep-research-client';
import { adminUpdateDocument } from '@/lib/document-admin';
import { adminUploadDocument } from '@/lib/document-storage-admin';
import { processDocumentFromContent } from '@/lib/document-processing-service';
import { createLogger } from '@/lib/logger';
import { annotateResearchReport, evaluateResearchEvidence } from '@/lib/research/primary-evidence';
import {
  nextDeepResearchProgress,
  shouldPersistDeepResearchProgress,
  type DeepResearchObservation,
  type DeepResearchProgress,
} from '@/lib/research/deep-research-progress';
import type { CapturedProviderUsage } from '@/lib/operation-context';
import type { DocumentResearchEvidence } from '@/lib/types';

const log = createLogger('inngest/run-document-deep-research');

/** Maximum number of poll iterations (~15 minutes at 15s intervals). */
const MAX_POLL_ITERATIONS = 60;

/** Seconds between polls. Stated on the progress snapshot so the owner-facing
 * "N of 60 checks" reads as OUR poll budget rather than a provider estimate. */
const POLL_INTERVAL_SECONDS = 15;

/**
 * ARUN-022 — best-effort flush of any Deep Research terminal capture as a
 * `job-run` receipt. Guarded + dynamic so an instrumentation load failure
 * degrades to "no receipt" and never breaks research. Non-fatal: a receipt loss
 * is logged and swallowed (the durable accounting marker inside the flush
 * records the loss when it can). Returns the flush outcome for telemetry.
 */
async function recordDeepResearchReceipts(
  runId: string,
  owner: string,
  captured: readonly CapturedProviderUsage[]
): Promise<void> {
  if (captured.length === 0) return;
  try {
    const { flushCapturedUsage } = await import('@/lib/operation-receipt-instrument');
    await flushCapturedUsage(
      {
        parentType: 'job-run',
        owner,
        correlationId: `deep-research-${runId}`,
        inngestRunId: runId,
      },
      captured,
      `deep-research-${runId}`,
      // A background research job has no parent headline to fold into.
      'standalone'
    );
  } catch (error) {
    log.warn('Deep research receipt flush failed (best-effort, non-fatal)', {
      runId,
      owner,
      captured: captured.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Run Gemini Deep Research and save result as a document.
 *
 * **Trigger:** `app/document.deep-research.requested` event
 */
export const runDocumentDeepResearchJob = inngest.createFunction(
  {
    id: 'run-document-deep-research',
    name: 'Run Document Deep Research',
    retries: 2,
    concurrency: { limit: 3 },

    onFailure: async ({ error, event }) => {
      // In Inngest onFailure, the original event is nested under event.data.event
      const originalEvent = (event.data as Record<string, unknown>).event as
        { data?: Record<string, unknown> } | undefined;
      const documentId = (originalEvent?.data?.documentId ?? '') as string;

      log.error('Deep research job failed after all retries', new Error(error.message), {
        documentId,
      });

      if (!documentId) {
        log.error('Cannot update document on failure — documentId is empty', new Error('empty documentId'));
        return;
      }

      try {
        await adminUpdateDocument(documentId, {
          status: 'failed',
          errorMessage: `Deep research failed: ${error.message}`,
        });
      } catch (updateError) {
        log.error(
          'Failed to update document status on failure',
          updateError instanceof Error ? updateError : undefined
        );
      }
    },
  },

  { event: 'app/document.deep-research.requested' },

  async ({ event, step, runId }) => {
    const { query, documentId, userId, proposedArtifactId } = event.data;
    const owner = `user:${userId}`;
    // OBS-006: durable start instant — see durable-duration.ts. This trigger
    // carries no accepted-at token, so queue wait is not separable and the report
    // is honestly based on `started-to-terminal` rather than inventing one.
    const startedAtMs = await captureDurableInstantMs(step, 'capture-start-time');

    log.info('Starting document deep research', { documentId, query: query.substring(0, 100) });

    // ARUN-022 — load the capture/flush instrumentation once (guarded dynamic
    // import). A load failure degrades to "no sink" and research still runs;
    // the poll wrapper below falls back to an uncaptured poll.
    let withCapturedUsage:
      ((fn: () => Promise<unknown>) => Promise<{ result: unknown; captured: CapturedProviderUsage[] }>) | undefined;
    try {
      ({ withCapturedUsage } = await import('@/lib/operation-receipt-instrument'));
    } catch (instrumentationError) {
      log.warn('operation-usage instrumentation unavailable; deep research will not emit receipts', {
        error: instrumentationError instanceof Error ? instrumentationError.message : String(instrumentationError),
      });
    }

    // Step 1: Start deep research
    const { interactionId } = await step.run('start-research', async () => {
      const result = await startDeepResearch(query);
      log.info('Deep research interaction started', {
        documentId,
        interactionId: result.interactionId,
      });
      return result;
    });

    // PRODUCT-003 — persist the interaction id immediately. It is the only
    // handle by which a run that outlasts our poll budget can be checked again,
    // and without it a timeout is indistinguishable from a lost run.
    await step.run('record-interaction', async () => {
      try {
        await adminUpdateDocument(documentId, { deepResearchInteractionId: interactionId });
      } catch (error) {
        // Progress reporting must never break research; the run continues
        // without a resume handle rather than failing outright.
        log.warn('Could not persist deep-research interaction id (non-fatal)', {
          documentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Step 2: Poll for completion using Inngest step.sleep() for proper checkpointing
    let researchText = '';
    let researchCompleted = false;
    let terminalCaptured: CapturedProviderUsage[] = [];
    // PRODUCT-003 — accumulated ONLY from memoized `step.run` results, so an
    // Inngest replay re-derives an identical snapshot. A mutated closure would
    // restart the stall counter from zero on every resume (the same class of
    // bug the durable-instant helpers exist to prevent).
    let progress: DeepResearchProgress | undefined;
    const foldProgress = (
      observation: DeepResearchObservation,
      iteration: number,
      terminal?: DeepResearchProgress['terminal']
    ): DeepResearchProgress =>
      nextDeepResearchProgress(progress, observation, {
        interactionId,
        pollIteration: iteration,
        maxPollIterations: MAX_POLL_ITERATIONS,
        pollIntervalSeconds: POLL_INTERVAL_SECONDS,
        ...(terminal ? { terminal } : {}),
      });
    const persistProgress = async (snapshot: DeepResearchProgress, label: string): Promise<void> => {
      await step.run(label, async () => {
        try {
          await adminUpdateDocument(documentId, { deepResearchProgress: snapshot });
        } catch (error) {
          log.warn('Could not persist deep-research progress (non-fatal)', {
            documentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    };

    for (let i = 0; i < MAX_POLL_ITERATIONS; i++) {
      const pollOutcome = await step.run(`poll-${i}`, async () => {
        if (withCapturedUsage) {
          const { result, captured } = await withCapturedUsage(() => pollDeepResearch(interactionId));
          return { pollResult: result as Awaited<ReturnType<typeof pollDeepResearch>>, captured };
        }
        return {
          pollResult: await pollDeepResearch(interactionId),
          captured: [] as CapturedProviderUsage[],
        };
      });
      const pollResult = pollOutcome.pollResult;
      // Only the terminal poll captures provider usage; keep it so it can be
      // flushed once the run's outcome is known (memoized → stable on replay).
      if (pollOutcome.captured.length > 0) terminalCaptured = pollOutcome.captured;

      // A poll result may legitimately carry no observation: an Inngest run
      // that was already in flight when this code deployed replays MEMOIZED
      // poll results from the previous build, which predate the `progress`
      // field. Skipping the fold leaves the snapshot untouched — honest, and
      // deterministic on replay — rather than inventing an observation.
      if (pollResult.progress) {
        const terminalForProgress: DeepResearchProgress['terminal'] | undefined =
          pollResult.status === 'completed'
            ? { state: 'completed' }
            : pollResult.status === 'failed'
              ? { state: 'failed', ...(pollResult.reason ? { reason: pollResult.reason } : {}) }
              : undefined;
        const previousProgress = progress;
        progress = foldProgress(pollResult.progress, i, terminalForProgress);
        if (shouldPersistDeepResearchProgress(previousProgress, progress)) {
          await persistProgress(progress, `progress-${i}`);
        }
      }

      if (pollResult.status === 'completed') {
        log.info('Deep research completed', { documentId, interactionId, iteration: i });
        researchText = pollResult.text ?? '';
        researchCompleted = true;
        break;
      }

      if (pollResult.status === 'failed') {
        const reason = pollResult.reason ?? 'Deep research task failed';
        // Flush the failed attempt's provider spend BEFORE throwing so the
        // billable-but-failed attempt stays durably visible (a throw here would
        // otherwise lose the terminal capture).
        await recordDeepResearchReceipts(runId, owner, terminalCaptured);
        // A poll result carrying a reason is a terminal state (e.g. requires_action) —
        // retries cannot resolve it, so mark the document failed with the truthful
        // message immediately instead of waiting for onFailure after all retries.
        // `terminal` is the explicit flag; the legacy `reason`-implies-terminal
        // reading is kept as the fallback so a memoized pre-deploy poll result
        // still short-circuits instead of burning the retry budget.
        if (pollResult.terminal ?? Boolean(pollResult.reason)) {
          await step.run(`mark-failed-${i}`, async () => {
            try {
              await adminUpdateDocument(documentId, {
                status: 'failed',
                errorMessage: reason,
              });
            } catch (updateError) {
              log.error(
                'Failed to mark document failed after terminal poll result',
                updateError instanceof Error ? updateError : new Error(String(updateError)),
                { documentId }
              );
            }
          });
        }
        throw new Error(reason);
      }

      // Sleep 15 seconds between polls — Inngest checkpoints between steps
      await step.sleep(`wait-${i}`, '15s');
    }

    if (!researchCompleted) {
      // Timed out — still flush any terminal capture (e.g. a late failure) so
      // the spend is never silently lost before the timeout throw.
      await recordDeepResearchReceipts(runId, owner, terminalCaptured);
      // PRODUCT-003: OUR poll budget ran out; the provider task may well still
      // be running. Record that distinction (and keep the snapshot resumable)
      // instead of leaving a bare "failed" that implies the research died.
      if (progress) {
        await persistProgress(
          {
            ...progress,
            terminal: {
              state: 'timed-out',
              reason: `Stopped polling after ${MAX_POLL_ITERATIONS} checks; the provider last reported "${progress.providerStatus}"`,
            },
            resumable: true,
          },
          'progress-timed-out'
        );
      }
      throw new Error(`Deep research timed out after ${MAX_POLL_ITERATIONS} poll iterations`);
    }

    // ARUN-022 — record the completed research's provider spend as a durable
    // job-run receipt. A separate, fully try/caught step so a ledger failure is
    // non-fatal and never perturbs the document pipeline; only runs when a
    // provider call was actually captured.
    if (terminalCaptured.length > 0) {
      await step.run('record-usage-receipts', async () => {
        await recordDeepResearchReceipts(runId, owner, terminalCaptured);
      });
    }

    // AI-038 — evidence gate. Pure and deterministic (markdown in, verdict out),
    // so it is computed OUTSIDE a step: it costs nothing, re-derives identically
    // on replay, and needs no memoization.
    //
    // The report is retained either way — it is a paid, multi-minute artifact
    // and a weakly-sourced answer still has value to a reader who knows it is
    // weakly sourced. What is NOT allowed is filing it as an ordinary document.
    // A non-`sufficient` verdict is written INTO the markdown, before upload and
    // before chunking, so the caveat travels into every search chunk and every
    // citation rather than living on one library screen the reader never opens.
    const evidence = evaluateResearchEvidence(researchText);
    const annotatedText = annotateResearchReport(researchText, evidence);
    const researchEvidence: DocumentResearchEvidence = {
      verdict: evidence.verdict,
      totalCitations: evidence.totalCitations,
      primaryCitations: evidence.primaryCitations,
      secondaryCitations: evidence.secondaryCitations,
      searchRedirectCitations: evidence.searchRedirectCitations,
      unusableCitations: evidence.unusableCitations,
      distinctPrimaryDomains: evidence.distinctPrimaryDomains,
      primaryDomains: evidence.primaryDomains,
      identifierClaims: evidence.identifierClaims,
      unsupportedIdentifiers: evidence.unsupportedIdentifiers,
      findingCodes: evidence.findings.map((finding) => finding.code),
      // OBS-006: the memoized run start, not a fresh `Date.now()`. This value is
      // computed outside a step, so a non-durable instant here would change on
      // every replay and the persisted evidence stamp would drift.
      evaluatedAt: startedAtMs,
    };

    if (evidence.verdict !== 'sufficient') {
      log.warn('Deep research report did not clear the primary-evidence gate', {
        documentId,
        verdict: evidence.verdict,
        findings: researchEvidence.findingCodes,
        totalCitations: evidence.totalCitations,
        primaryCitations: evidence.primaryCitations,
        searchRedirectCitations: evidence.searchRedirectCitations,
        unsupportedIdentifiers: evidence.unsupportedIdentifiers.length,
      });
    }

    // Step 3: Upload result to Firebase Storage
    const storageUrl = await step.run('save-to-storage', async () => {
      if (!researchText || researchText.trim().length === 0) {
        throw new Error('Deep research returned empty result');
      }

      const fileName = `deep-research-${documentId}.md`;
      const buffer = Buffer.from(annotatedText, 'utf-8');

      const uploadResult = await adminUploadDocument(buffer, fileName, 'text/markdown', userId);

      if (!uploadResult.success) {
        throw new Error(`Failed to upload research result: ${uploadResult.error || 'Unknown error'}`);
      }

      log.info('Uploaded research result', { documentId, storageUrl: uploadResult.storageUrl });
      return uploadResult.storageUrl;
    });

    // Step 4: Update document metadata
    await step.run('update-document', async () => {
      await adminUpdateDocument(documentId, {
        storageUrl,
        fileSize: Buffer.byteLength(annotatedText, 'utf-8'),
        mimeType: 'text/markdown',
        researchEvidence,
      });
      log.info('Updated document metadata', { documentId, evidenceVerdict: researchEvidence.verdict });
    });

    // Step 5: Chunk document for search/citations
    await step.run('chunk-document', async () => {
      // Chunk the ANNOTATED text — a retrieved chunk of an unverified report
      // must be able to carry its own caveat.
      const result = await processDocumentFromContent(documentId, annotatedText);

      if (!result.success) {
        log.warn('Document chunking failed', {
          documentId,
          error: result.error,
          stage: result.stage,
        });
        // AI-021: processDocumentFromContent already marked the document
        // `failed` — that state is truthful and must stand. Throw so Inngest
        // can retry a transient chunking failure; onFailure keeps the honest
        // failed state if every retry is exhausted. Never overwrite a failed
        // chunking pass with a misleading `processed`.
        throw new Error(`Chunking failed at stage ${result.stage ?? 'unknown'}: ${result.error}`);
      }

      log.info('Document chunked successfully', {
        documentId,
        chunkCount: result.chunkCount,
      });
    });

    // Step 6: Sync document to Neo4j graph (best-effort)
    await step.run('sync-to-graph', async () => {
      try {
        await inngest.send({
          name: 'app/document.sync.requested',
          data: { documentId, operation: 'update' },
        });
      } catch {
        // Graph sync is best-effort
      }
    });

    // Step 7: If this research was an approved artifact RECOMMENDATION, flip it to 'ready'
    // (the document is now filled). Best-effort — never fails the research job.
    if (proposedArtifactId) {
      await step.run('mark-recommendation-ready', async () => {
        try {
          const { updateProposedArtifact } = await import('@/lib/proposed-artifacts-admin');
          await updateProposedArtifact(proposedArtifactId, { generationStatus: 'ready' });
          log.info('artifact recommendation marked ready after research', { proposedArtifactId, documentId });
        } catch (err) {
          log.warn('could not mark recommendation ready (ignored)', {
            proposedArtifactId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    // OBS-006: both endpoints memoized. This job polls the provider inside
    // `step.sleep`-checkpointed iterations, so its wall time spans many separate
    // HTTP requests — precisely the shape a handler-body `Date.now()` cannot
    // measure.
    const completedAtMs = await captureDurableInstantMs(step, 'capture-end-time');
    const timing = deriveDurableTimingMs({ startedAtMs, completedAtMs });

    log.info('Document deep research completed', {
      documentId,
      query: query.substring(0, 100),
      ...timing,
      resultLength: annotatedText.length,
      evidenceVerdict: researchEvidence.verdict,
    });

    return declareDomainOutcome(
      {
        success: true,
        documentId,
        ...timing,
        resultLength: annotatedText.length,
        evidenceVerdict: researchEvidence.verdict,
      },
      { outcome: 'success' }
    );
  }
);
