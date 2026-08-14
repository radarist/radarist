/**
 * @file route.ts
 * @description SSE streaming endpoint for agent events.
 *
 * Streams real-time agent activity to the frontend using Server-Sent Events.
 * Uses Firestore polling (not in-memory) to bridge Inngest workers.
 * Auth via Bearer token in Authorization header (not EventSource — can't send headers).
 *
 * @phase Phase 3: SSE Event Gateway
 */

import { NextRequest } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { withAuthFailureReason } from '@/lib/auth-failure-response';
import { getEventsAfterSequence } from '@/lib/agent-events';

export const runtime = 'nodejs';

/** Poll interval in milliseconds */
const POLL_INTERVAL_MS = 1000;

/** Close connection after this many consecutive empty polls (~30 min dead-mission timeout) */
const MAX_EMPTY_POLLS = 1800;

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    // UX-056: keep the bare-text body (the client reads the stream, not JSON)
    // and carry the bounded reason in a header, so the hook can tell a stale
    // credential apart from a genuine sign-out without parsing prose.
    return withAuthFailureReason(new Response('Unauthorized', { status: 401 }), auth);
  }

  const lastSequence = parseInt(request.nextUrl.searchParams.get('lastSequence') ?? '0', 10);

  const userId = auth.uid!;
  const encoder = new TextEncoder();

  const abortSignal = request.signal;

  const stream = new ReadableStream({
    async start(controller) {
      let cursor = lastSequence;
      let emptyPolls = 0;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      abortSignal.addEventListener('abort', cleanup, { once: true });

      const poll = async () => {
        if (abortSignal.aborted) return;

        try {
          const events = await getEventsAfterSequence(userId, cursor);

          if (events.length > 0) {
            for (const event of events) {
              const sseMessage = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(sseMessage));
              cursor = event.sequence;
            }
            emptyPolls = 0;
          } else {
            emptyPolls++;
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          }

          if (emptyPolls >= MAX_EMPTY_POLLS) {
            cleanup();
            return;
          }

          timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
        } catch {
          cleanup();
        }
      };

      poll();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
