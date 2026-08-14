import { readFileSync } from 'fs';

export const LOCAL_RUNTIME_STATUS_SCHEMA_VERSION = 1;
export const LOCAL_CHECKPOINT_RPO_MS = 10 * 60_000;
export const LOCAL_CHECKPOINT_HEALTH_GRACE_MS = 60_000;
export const LOCAL_RUNTIME_HEARTBEAT_STALE_MS = 45_000;

export type LocalSupervisorState = 'starting' | 'running' | 'degraded' | 'stopping';
export type LocalCheckpointState =
  | 'ephemeral'
  | 'pending'
  | 'healthy'
  | 'degraded'
  | 'not-configured';

export interface LocalRuntimeStatusFile {
  schemaVersion: 1;
  profile: string;
  projectId: string;
  startedAt: string;
  updatedAt: string;
  supervisor: {
    state: LocalSupervisorState;
    unexpectedExit: boolean;
    orphanCount: number;
  };
  checkpoint: {
    state: LocalCheckpointState;
    lastSuccessAt?: string;
    lastFailureAt?: string;
  };
}

export interface PublicLocalRuntimeHealth {
  status: 'up' | 'down' | 'not-configured';
  supervisor: LocalSupervisorState | 'not-configured';
  checkpoint: LocalCheckpointState;
  checkpointAgeMs?: number;
  heartbeatAgeMs?: number;
  orphanCount?: number;
  error?: string;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function parseLocalRuntimeStatus(value: unknown): LocalRuntimeStatusFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid runtime status');
  }
  const candidate = value as Partial<LocalRuntimeStatusFile>;
  const supervisor = candidate.supervisor;
  const checkpoint = candidate.checkpoint;
  if (
    candidate.schemaVersion !== LOCAL_RUNTIME_STATUS_SCHEMA_VERSION ||
    typeof candidate.profile !== 'string' ||
    !candidate.profile ||
    typeof candidate.projectId !== 'string' ||
    !candidate.projectId.startsWith('demo-') ||
    !validDate(candidate.startedAt) ||
    !validDate(candidate.updatedAt) ||
    !supervisor ||
    !['starting', 'running', 'degraded', 'stopping'].includes(supervisor.state) ||
    typeof supervisor.unexpectedExit !== 'boolean' ||
    !Number.isSafeInteger(supervisor.orphanCount) ||
    supervisor.orphanCount < 0 ||
    !checkpoint ||
    !['ephemeral', 'pending', 'healthy', 'degraded', 'not-configured'].includes(checkpoint.state) ||
    (checkpoint.lastSuccessAt !== undefined && !validDate(checkpoint.lastSuccessAt)) ||
    (checkpoint.lastFailureAt !== undefined && !validDate(checkpoint.lastFailureAt))
  ) {
    throw new Error('invalid runtime status');
  }
  return candidate as LocalRuntimeStatusFile;
}

export function derivePublicLocalRuntimeHealth(
  status: LocalRuntimeStatusFile,
  nowMs = Date.now()
): PublicLocalRuntimeHealth {
  const lastSuccessMs = status.checkpoint.lastSuccessAt
    ? Date.parse(status.checkpoint.lastSuccessAt)
    : undefined;
  const checkpointAgeMs = lastSuccessMs === undefined ? undefined : Math.max(0, nowMs - lastSuccessMs);
  const heartbeatAgeMs = Math.max(0, nowMs - Date.parse(status.updatedAt));
  const stale =
    checkpointAgeMs !== undefined &&
    checkpointAgeMs > LOCAL_CHECKPOINT_RPO_MS + LOCAL_CHECKPOINT_HEALTH_GRACE_MS;
  const runtimeDown =
    status.supervisor.state === 'degraded' ||
    status.supervisor.unexpectedExit ||
    status.supervisor.orphanCount > 0 ||
    status.checkpoint.state === 'degraded' ||
    status.checkpoint.state === 'not-configured' ||
    heartbeatAgeMs > LOCAL_RUNTIME_HEARTBEAT_STALE_MS ||
    stale;

  return {
    status: runtimeDown ? 'down' : 'up',
    supervisor: status.supervisor.state,
    checkpoint: stale ? 'degraded' : status.checkpoint.state,
    ...(checkpointAgeMs === undefined ? {} : { checkpointAgeMs }),
    heartbeatAgeMs,
    orphanCount: status.supervisor.orphanCount,
    ...(runtimeDown ? { error: 'local runtime requires attention' } : {}),
  };
}

export function readPublicLocalRuntimeHealth(
  statusFile: string | undefined,
  nowMs = Date.now()
): PublicLocalRuntimeHealth {
  if (!statusFile) {
    return {
      status: 'not-configured',
      supervisor: 'not-configured',
      checkpoint: 'not-configured',
    };
  }
  try {
    const parsed = parseLocalRuntimeStatus(JSON.parse(readFileSync(statusFile, 'utf8')));
    return derivePublicLocalRuntimeHealth(parsed, nowMs);
  } catch {
    return {
      status: 'down',
      supervisor: 'degraded',
      checkpoint: 'degraded',
      error: 'local runtime status is unavailable',
    };
  }
}
