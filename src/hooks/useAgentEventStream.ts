/**
 * @file useAgentEventStream.ts
 * @description Fetch-based SSE reader for real-time agent events.
 *
 * Uses `fetch()` instead of `EventSource` because EventSource cannot send
 * Authorization headers. Parses SSE text protocol manually, deduplicates
 * events by ID, and auto-reconnects on disconnect.
 *
 * @phase Phase 3: SSE Event Gateway
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { auth } from '@/lib/firebase';
import type { AgentEvent } from '@/lib/schemas/agent-event';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { AUTH_FAILURE_REASON_HEADER, parseAuthFailureReason, requiresSessionReset } from '@/lib/auth-failure';
import { requestAuthSessionRecovery } from '@/lib/auth-session-recovery';

/** Maximum events to keep in state (ring buffer) */
const MAX_EVENTS = 100;

/** Initial delay before reconnection (ms) */
const INITIAL_RECONNECT_DELAY_MS = 1000;
/** Maximum backoff delay (ms) */
const MAX_RECONNECT_DELAY_MS = 30000;

export function useAgentEventStream(enabled = true) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  /**
   * UX-056 — the stream stopped because authentication was refused, not because
   * the network hiccuped. Terminal by design: reconnecting cannot change an auth
   * verdict, and `fetch-with-auth` has already spent the one permitted
   * force-refreshed retry before the 401 reaches this hook.
   */
  const [sessionEnded, setSessionEnded] = useState(false);
  const sessionEndedRef = useRef(false);
  // Start from "now" (microsecond-precision, matching the server's sequence
  // scheme in agent-events.ts) so the first connect shows *new* events, not
  // the entire 36k-event historical backlog. The server-side query uses the
  // (userId, sequence) composite index so each poll returns only this user's
  // events after this cursor.
  const lastSequenceRef = useRef(Date.now() * 1000);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  const connect = useCallback(async () => {
    if (!auth.currentUser) return;
    if (sessionEndedRef.current) return;

    abortControllerRef.current = new AbortController();

    try {
      const response = await fetchWithAuth(`/api/events/stream?lastSequence=${lastSequenceRef.current}`, {
        headers: {},
        signal: abortControllerRef.current.signal,
      });

      if (response.status === 401) {
        // UX-056: an authentication refusal is terminal for this stream. The
        // base behaviour was to fall through to the backoff loop, so a retained
        // browser re-requested the stream every 30s indefinitely — never
        // refreshing, never recovering, never stopping.
        const reason = parseAuthFailureReason(response.headers.get(AUTH_FAILURE_REASON_HEADER));
        sessionEndedRef.current = true;
        setSessionEnded(true);
        setConnectionError(true);
        // Only a classified reason justifies discarding the local session; an
        // unclassified 401 stops the stream and nothing more.
        if (reason && requiresSessionReset(reason)) requestAuthSessionRecovery(reason);
        return;
      }

      if (!response.ok || !response.body) {
        console.warn('[SSE] Stream response not OK:', response.status, response.statusText);
        setConnectionError(true);
        return;
      }
      setIsConnected(true);
      setConnectionError(false);
      retryCountRef.current = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          if (block.startsWith(': keepalive')) continue;

          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;

          try {
            const event: AgentEvent = JSON.parse(dataLine.slice(6));
            lastSequenceRef.current = event.sequence;
            setEvents((prev) => {
              if (prev.some((e) => e.id === event.id)) return prev;
              return [...prev.slice(-(MAX_EVENTS - 1)), event];
            });
          } catch {
            /* skip malformed events */
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.warn('[SSE] Connection error:', err);
        setConnectionError(true);
      }
    } finally {
      setIsConnected(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let mounted = true;

    const connectWithReconnect = async () => {
      await connect();
      if (mounted && !sessionEndedRef.current) {
        const delay = Math.min(INITIAL_RECONNECT_DELAY_MS * Math.pow(2, retryCountRef.current), MAX_RECONNECT_DELAY_MS);
        retryCountRef.current++;
        reconnectTimeoutRef.current = setTimeout(connectWithReconnect, delay);
      }
    };

    connectWithReconnect();

    return () => {
      mounted = false;
      abortControllerRef.current?.abort();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [enabled, connect]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, isConnected, connectionError, sessionEnded, clearEvents };
}
