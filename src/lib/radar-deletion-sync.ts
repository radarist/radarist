/**
 * Durable graph-cleanup handoff for radar deletion.
 *
 * The caller must await this before removing the final Firestore radar doc.
 * If dispatch fails, that document remains as a retry anchor even when the
 * placement batch has already committed.
 */

/**
 * Upper bound on the dispatch await. When the Inngest dev server is down or
 * unreachable the SDK can keep retrying far longer than any caller (or UI
 * failure surface) should wait; a bounded rejection lets the deletion
 * boundary report retryable pre-commit truth instead of hanging. If the
 * abandoned dispatch later succeeds anyway, the radar doc is still present
 * and a retry of the idempotent cascade converges — same contract as any
 * other handoff failure.
 */
const HANDOFF_TIMEOUT_MS = 15_000;

export async function requestRadarGraphDeletion(radarId: string, cascade: boolean): Promise<void> {
  const { inngest } = await import('@/lib/inngest/send-client');

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Radar graph-cleanup handoff timed out after ${HANDOFF_TIMEOUT_MS}ms — the radar was not deleted and it is safe to retry.`
          )
        ),
      HANDOFF_TIMEOUT_MS
    );
  });

  try {
    await Promise.race([
      inngest.send({
        name: 'app/radar.graph-delete.requested',
        data: { radarId, cascade },
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
