type InngestEnvironment = Record<string, string | undefined>;

/** Explicit operator kill switch shared by server and browser send clients. */
export function isInngestExplicitlyDisabled(env: InngestEnvironment = process.env): boolean {
  return env.INNGEST_ENABLED === 'false' || env.NEXT_PUBLIC_INNGEST_ENABLED === 'false';
}

/** Preserve the SDK send contract while making the explicit kill switch a no-op. */
export function withInngestKillSwitch<TArgs extends unknown[]>(
  send: (...args: TArgs) => Promise<{ ids: string[] }>,
  disabled: boolean
): (...args: TArgs) => Promise<{ ids: string[] }> {
  return (...args) => (disabled ? Promise.resolve({ ids: [] }) : send(...args));
}

/** Unit tests must never auto-discover a developer's live Inngest server. */
export function isInngestUnitTestSendBlocked(env: InngestEnvironment = process.env): boolean {
  return env.NODE_ENV === 'test' || typeof env.JEST_WORKER_ID === 'string';
}

/** Fail closed so an unmocked unit-test send is visible without reaching port 8288. */
export function withInngestUnitTestGuard<TArgs extends unknown[]>(
  send: (...args: TArgs) => Promise<{ ids: string[] }>,
  blocked: boolean
): (...args: TArgs) => Promise<{ ids: string[] }> {
  return (...args) =>
    blocked
      ? Promise.reject(
          new Error(
            '[Inngest] Refusing an unmocked event send from a unit-test process. Mock the send client or exercise events through a disposable integration stack.'
          )
        )
      : send(...args);
}

function isHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** SDK-recognized routing variables; app-only health aliases do not count. */
export function hasInngestDevRouting(env: InngestEnvironment = process.env): boolean {
  const dev = env.INNGEST_DEV?.trim().toLowerCase();
  if (dev === 'true' || dev === '1' || isHttpUrl(env.INNGEST_DEV)) return true;

  return env.NODE_ENV === 'development' && isHttpUrl(env.INNGEST_BASE_URL);
}

export function isInngestEnvironmentConfigured(env: InngestEnvironment = process.env): boolean {
  if (isInngestExplicitlyDisabled(env)) return false;
  if (hasInngestDevRouting(env)) return true;
  if (env.NODE_ENV === 'development') {
    return Boolean(env.INNGEST_EVENT_KEY);
  }
  return Boolean(env.INNGEST_EVENT_KEY);
}
