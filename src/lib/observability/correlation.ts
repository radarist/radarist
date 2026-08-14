/**
 * Opaque identifier shared by one relation mutation and its async projections.
 *
 * The deliberately narrow UUIDv4 format prevents caller-controlled text from
 * being copied into logs, job diagnostics, or graph properties.
 */
export const CORRELATION_ID_HEADER = 'x-radarist-correlation-id';
export const CORRELATION_ID_LENGTH = 41;

const CORRELATION_ID_PATTERN = /^corr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CorrelationContext {
  correlationId?: string;
}

export class InvalidCorrelationIdError extends Error {
  constructor() {
    super('Invalid correlation ID');
    this.name = 'InvalidCorrelationIdError';
  }
}

function createUuidV4(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().toLowerCase();
  }

  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure random generation is unavailable');
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createCorrelationId(): string {
  return `corr_${createUuidV4()}`;
}

export function parseCorrelationId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== CORRELATION_ID_LENGTH) return null;
  return CORRELATION_ID_PATTERN.test(value) ? value : null;
}

export function isCorrelationId(value: unknown): value is string {
  return parseCorrelationId(value) !== null;
}

/** Upper bound on a correlated mission id — far above the real format. */
export const MISSION_ID_MAX_LENGTH = 128;

/**
 * Firestore-document-id-safe subset: no separators, no dot segments, no
 * `__reserved__` form.
 */
const MISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * ARUN-023 — bounded mission correlation for job-run diagnostics.
 *
 * The `inngest/function.cancelled` payload carries only `function_id` and
 * `run_id`, never the original event, so a cancelled run's mission link has to
 * be established when the run STARTS. This parser is what keeps that link from
 * becoming an arbitrary-caller-text channel: same OBS-003 posture as
 * {@link parseCorrelationId} — an unrecognised value is discarded, never
 * persisted.
 */
export function parseMissionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MISSION_ID_MAX_LENGTH) return null;
  if (trimmed.startsWith('__') && trimmed.endsWith('__')) return null;
  return MISSION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Generate when absent; reject, rather than rewrite, an explicitly supplied value. */
export function resolveCorrelationId(value?: string | null): string {
  if (value == null) return createCorrelationId();
  const parsed = parseCorrelationId(value);
  if (!parsed) throw new InvalidCorrelationIdError();
  return parsed;
}

/** Read an HTTP header, minting only when it is genuinely absent. */
export function correlationIdFromHeaders(headers: Pick<Headers, 'get'>): string | null {
  const supplied = headers.get(CORRELATION_ID_HEADER);
  return supplied === null ? createCorrelationId() : parseCorrelationId(supplied);
}

export function withCorrelationIdHeader<T extends Response>(response: T, correlationId: string): T {
  const parsed = parseCorrelationId(correlationId);
  if (!parsed) throw new InvalidCorrelationIdError();
  response.headers.set(CORRELATION_ID_HEADER, parsed);
  return response;
}
