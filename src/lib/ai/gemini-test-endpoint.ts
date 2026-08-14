/**
 * @file gemini-test-endpoint.ts
 * @description TEST-017/AI-020 — guarded deterministic-provider seam for
 * Gemini SDK consumers. Resolves the SDK's supported `RequestOptions.baseUrl`
 * override so deterministic acceptances can drive the real Assistant chat,
 * structured-research, content-generation, and embedding paths against a
 * loopback stub instead of live model output. This module decides exactly one
 * thing: whether the override is allowed to exist for this process.
 *
 * ## Threat analysis (the provider seam)
 *
 * The seam can redirect every opted-in Gemini SDK request in this server
 * process, so the threat model treats it as a full prompt/tool-result/content
 * egress channel:
 *
 * 1. **Prompt/data exfiltration** — an attacker who can influence env vars
 *    could point the model traffic (system prompt, user turns, tool results)
 *    at a host they control. Mitigation: the URL must parse and its hostname
 *    must be exactly a loopback literal (`127.0.0.1`, `localhost`, `::1`).
 *    Loopback keeps the bytes on the operator's own machine; DNS names that
 *    merely *contain* "localhost"/"127.0.0.1" are rejected by exact-match.
 * 2. **Production-data poisoning** — a stubbed model could be scripted to call
 *    write tools against real stores. Mitigation: activation additionally
 *    requires (a) `FIRESTORE_EMULATOR_HOST` to be set — this server's admin
 *    writes are already rerouted to a disposable emulator — and (b) every
 *    configured Firebase project id (`NEXT_PUBLIC_FIREBASE_PROJECT_ID`,
 *    `FIREBASE_PROJECT_ID`, `GCLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT`) to carry
 *    the Firebase-documented offline `demo-` prefix, with at least one set. A
 *    production deployment satisfies neither without first ceasing to be a
 *    production deployment; a split-brain env (any real project id anywhere)
 *    is vetoed outright.
 * 3. **Request-controlled activation** — nothing in this module reads request
 *    state. Activation is a process-env decision made by the operator who owns
 *    the server; a browser/user cannot reach it. The module is `server-only`,
 *    so a client-component import chain fails the build instead of shipping
 *    the logic (and the env var names carry no secrets regardless).
 * 4. **Silent misconfiguration** — a guard failure while the opt-in var IS set
 *    would otherwise quietly fall through to the real Google endpoint (visible
 *    only as a burned request against whatever key is configured). Mitigation:
 *    that state logs one structured warning per process naming the failed
 *    guard; the unset case stays silent and allocation-free.
 * 5. **Accidental spend** — the acceptance harness pairs this override with a
 *    deliberately fake API key, so even a mis-applied guard cannot bill: the
 *    request either reaches the loopback stub (key ignored) or reaches Google
 *    and is rejected as unauthenticated. This module never reads or logs keys.
 * 6. **No production test bypass** — the override changes WHERE provider bytes
 *    go, never WHO the caller is or what validation follows: authentication,
 *    tool authority (`relation-write-authority`), executor gates, structured
 *    schemas, and persistence guards run unchanged. There is deliberately no
 *    `NODE_ENV` shortcut in the guard set: a locally built production bundle
 *    pointed at a disposable emulator project may exercise the seam, while a
 *    real deployment (real project id, no emulator wiring) can never satisfy
 *    guards 2a+2b.
 *
 * Fail-closed contract: on ANY doubt this function returns `undefined` and the
 * SDK uses its normal endpoint. It never throws.
 */

import 'server-only';

import { createLogger } from '@/lib/logger';

const log = createLogger('ai/gemini-test-endpoint');

export interface GeminiTestRequestOptions {
  baseUrl: string;
}

/** Exact loopback hostnames the override may target (URL#hostname form). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const PROJECT_ID_ENV_KEYS = [
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'FIREBASE_PROJECT_ID',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
] as const;

/** One warning per process — misconfig visibility without log spam. */
let warnedRefusal = false;

function refuse(reason: string, detail: Record<string, unknown>): undefined {
  if (!warnedRefusal) {
    warnedRefusal = true;
    log.warn(`GEMINI_TEST_BASE_URL is set but IGNORED — ${reason}`, detail);
  }
  return undefined;
}

/**
 * Returns `{ baseUrl }` for the Gemini SDK's `RequestOptions` when — and only
 * when — every disposable-environment guard holds; `undefined` otherwise.
 */
export function resolveGeminiTestRequestOptions(
  env: NodeJS.ProcessEnv = process.env
): GeminiTestRequestOptions | undefined {
  const raw = env.GEMINI_TEST_BASE_URL?.trim();
  if (!raw) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse('the value is not a parseable absolute URL', { value: raw });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return refuse('only http(s) loopback URLs are allowed', { protocol: parsed.protocol });
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return refuse('the host is not a loopback literal', { hostname: parsed.hostname });
  }

  if (!env.FIRESTORE_EMULATOR_HOST?.trim()) {
    return refuse('FIRESTORE_EMULATOR_HOST is not set — this process is not emulator-wired', {});
  }

  const projectIds = PROJECT_ID_ENV_KEYS.map((key) => env[key]?.trim()).filter((value): value is string =>
    Boolean(value)
  );
  if (projectIds.length === 0) {
    return refuse('no Firebase project id is configured — cannot prove a disposable project', {});
  }
  const nonDisposable = projectIds.find((projectId) => !projectId.startsWith('demo-'));
  if (nonDisposable !== undefined) {
    return refuse('a configured Firebase project id is not a disposable demo-* project', {
      projectId: nonDisposable,
    });
  }

  return { baseUrl: raw };
}
