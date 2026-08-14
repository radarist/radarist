/**
 * Local runtime ownership: owned app URL + Inngest registration identity
 * (LOCAL-018).
 *
 * ## The defect this closes
 *
 * A six-day-old full-profile `inngest dev` process was registered against
 * `http://127.0.0.1:9002/api/inngest` — the same address an isolated paid
 * BUILD-017 arm was using. Its schedules repeatedly invoked the isolated app
 * and produced unrelated graph-job 500s. The spike runner attested its
 * Firestore project, sandbox port range, resource prefix and spend, but never
 * attested that it *owned* the app it was driving or the scheduler driving it.
 *
 * ## The detection
 *
 * An Inngest dev server publishes the app URLs it polls at `GET /dev`, under
 * `startOpts.urls` (verified against dev-server 1.36.0). That makes "is some
 * other scheduler already registered against my app?" a directly observable
 * fact rather than an assumption — so the arm can refuse *before* it spends.
 *
 * Every probe here is a read-only GET. Nothing in this module stops, mutates,
 * or otherwise touches a foreign runtime: detecting a conflict is the lane's
 * business, and resolving it is the operator's.
 */

/** The ordinary local interactive app; an isolated arm must never claim it. */
export const DEFAULT_APP_URL = 'http://127.0.0.1:9002';
/** The ordinary local Inngest dev server port. */
export const DEFAULT_INNGEST_DEV_URL = 'http://127.0.0.1:8288';
/** Inngest's serve route — what a scheduler actually registers against. */
export const INNGEST_SERVE_PATH = '/api/inngest';

const PROBE_TIMEOUT_MS = 4_000;

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Canonical form for comparing two references to the same local app.
 *
 * `localhost` and `127.0.0.1` are the same listener but different strings, and
 * a registration carries the serve path while an app URL usually does not.
 * Comparing raw strings would let a genuine collision slip through.
 */
export function normalizeAppUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const path = parsed.pathname.replace(/\/+$/, '');
  const servePath = path.endsWith(INNGEST_SERVE_PATH) ? path.slice(0, -INNGEST_SERVE_PATH.length) : path;
  return `${parsed.protocol}//${host}:${port}${servePath}`;
}

/** True when two URLs name the same local app, ignoring host alias and serve path. */
export function sameApp(a: string, b: string): boolean {
  const left = normalizeAppUrl(a);
  const right = normalizeAppUrl(b);
  return left !== null && left === right;
}

/** Extract the app URLs a dev server reports polling, tolerating shape drift. */
export function parseInngestRegistrations(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const startOpts = (payload as { startOpts?: unknown }).startOpts;
  if (typeof startOpts !== 'object' || startOpts === null) return [];
  const urls = (startOpts as { urls?: unknown }).urls;
  if (!Array.isArray(urls)) return [];
  return urls.filter((u): u is string => typeof u === 'string' && u.trim() !== '');
}

export interface SchedulerObservation {
  /** The dev server that was probed. */
  inngestUrl: string;
  /** False when nothing answered — an absent scheduler is not a conflict. */
  reachable: boolean;
  /** App URLs it reports polling. */
  registeredAppUrls: string[];
}

/**
 * Read-only probe of one Inngest dev server.
 *
 * Unreachable is reported, never thrown: "no scheduler there" is a normal and
 * safe answer, and turning it into an exception would make the preflight fail
 * for the wrong reason.
 */
export async function probeScheduler(inngestUrl: string, fetchLike: FetchLike): Promise<SchedulerObservation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchLike(`${inngestUrl.replace(/\/+$/, '')}/dev`, { signal: controller.signal });
    if (!response.ok) return { inngestUrl, reachable: false, registeredAppUrls: [] };
    return { inngestUrl, reachable: true, registeredAppUrls: parseInngestRegistrations(await response.json()) };
  } catch {
    return { inngestUrl, reachable: false, registeredAppUrls: [] };
  } finally {
    clearTimeout(timer);
  }
}

export interface OwnershipInput {
  /** The app URL this lane claims. */
  ownedAppUrl: string;
  /** The Inngest dev server this lane owns and will register itself. */
  ownedInngestUrl: string;
  /** Every dev server worth asking — always include the default. */
  candidateInngestUrls: readonly string[];
}

export interface OwnershipVerdict {
  refusals: string[];
  /** Foreign schedulers found registered against the owned app. */
  conflicts: SchedulerObservation[];
  observations: SchedulerObservation[];
}

/**
 * Static identity checks — no network, so a misconfigured arm is refused
 * before anything is probed, started, or spent.
 */
export function checkOwnedIdentity(input: OwnershipInput): string[] {
  const refusals: string[] = [];
  const app = normalizeAppUrl(input.ownedAppUrl);
  const inngest = normalizeAppUrl(input.ownedInngestUrl);

  if (app === null) {
    refusals.push(`Owned app URL is missing or unparseable (${JSON.stringify(input.ownedAppUrl)}).`);
  } else if (app === normalizeAppUrl(DEFAULT_APP_URL)) {
    refusals.push(
      `Owned app URL ${input.ownedAppUrl} is the default local app (${DEFAULT_APP_URL}) — an isolated ` +
        'runtime must claim a shifted port so retained local work cannot drive it.'
    );
  }
  if (inngest === null) {
    refusals.push(`Owned Inngest dev URL is missing or unparseable (${JSON.stringify(input.ownedInngestUrl)}).`);
  } else if (inngest === normalizeAppUrl(DEFAULT_INNGEST_DEV_URL)) {
    refusals.push(
      `Owned Inngest dev URL ${input.ownedInngestUrl} is the default scheduler (${DEFAULT_INNGEST_DEV_URL}) — ` +
        'the arm would share a scheduler with retained local work.'
    );
  }
  if (app !== null && inngest !== null && app === inngest) {
    refusals.push('Owned app URL and Inngest dev URL are the same listener; they must be distinct.');
  }
  return refusals;
}

/**
 * Full ownership verdict: identity plus a live foreign-registration sweep.
 *
 * Refuses when any scheduler OTHER than the lane's own reports polling the
 * lane's app. That is the exact condition that silently drove the isolated
 * BUILD-017 app, and it is checked before dispatch or spend.
 */
export async function resolveRuntimeOwnership(input: OwnershipInput, fetchLike: FetchLike): Promise<OwnershipVerdict> {
  const refusals = checkOwnedIdentity(input);
  const observations: SchedulerObservation[] = [];
  const conflicts: SchedulerObservation[] = [];

  const candidates = Array.from(
    new Set([...input.candidateInngestUrls, DEFAULT_INNGEST_DEV_URL].map((u) => u.trim()).filter(Boolean))
  ).filter((candidate) => !sameApp(candidate, input.ownedInngestUrl));

  for (const candidate of candidates) {
    const observation = await probeScheduler(candidate, fetchLike);
    observations.push(observation);
    if (!observation.reachable) continue;
    if (observation.registeredAppUrls.some((registered) => sameApp(registered, input.ownedAppUrl))) {
      conflicts.push(observation);
      refusals.push(
        `A foreign Inngest scheduler at ${observation.inngestUrl} is already registered against the owned app ` +
          `${input.ownedAppUrl} (${observation.registeredAppUrls.join(', ')}). Its schedules would invoke this ` +
          'runtime. Refusing before dispatch or spend; the foreign runtime was left running and untouched.'
      );
    }
  }

  return { refusals, conflicts, observations };
}
