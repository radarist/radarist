/**
 * @file scripts/lib/docker-container-cleanup.ts
 * @description Bounded Docker container teardown shared by disposable local
 * runtimes. Callers must prove ownership before invoking this helper.
 */

export interface DockerContainerCleanupHooks {
  readonly stop: (reference: string) => void;
  readonly forceRemove: (reference: string) => void;
  readonly exists: (reference: string) => boolean;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface DockerContainerCleanupOptions {
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
}

const defaultWait = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

/**
 * Docker may return from `stop` before an auto-remove container has finished
 * disappearing. Prove absence before a caller removes any named volume the
 * container referenced.
 */
export async function stopAndRemoveDockerContainer(
  reference: string,
  hooks: DockerContainerCleanupHooks,
  options: DockerContainerCleanupOptions = {}
): Promise<void> {
  const pollAttempts = options.pollAttempts ?? 100;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!reference.trim()) throw new Error('Docker container reference is required.');
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts < 1) {
    throw new Error('Docker cleanup poll attempts must be a positive integer.');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('Docker cleanup poll interval must be a non-negative integer.');
  }

  hooks.stop(reference);

  try {
    hooks.forceRemove(reference);
  } catch {
    // `docker run --rm` begins asynchronous removal as soon as stop completes.
    // Docker then rejects a simultaneous `rm --force` with "removal ... is
    // already in progress" while `inspect` still sees the container. Some
    // command wrappers intentionally redact Docker stderr, so the thrown error
    // cannot be classified reliably. The bounded absence proof below is the
    // authority: any removal error is harmless only if the container actually
    // disappears, otherwise cleanup still fails closed.
  }

  const wait = hooks.wait ?? defaultWait;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    if (!hooks.exists(reference)) return;
    if (attempt + 1 < pollAttempts) await wait(pollIntervalMs);
  }
  throw new Error(`Docker container ${reference} still exists after cleanup.`);
}
