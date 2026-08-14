/**
 * @file lib/tdm-policy.ts
 * @description Text-and-Data-Mining (TDM) opt-out policy check for web ingestion.
 *
 * Implements respect for machine-readable rights reservations under the EU DSM
 * Directive (EU) 2019/790 Art 4(3): before Radarist fetches a web page for
 * ingestion, it consults the site's `robots.txt` and the emerging `ai.txt` /
 * `.well-known/ai.txt` TDM-reservation files. If the site has opted the target
 * path out (for our agent or for `*`), ingestion is refused and the document is
 * marked blocked.
 *
 * Zero dependencies (OSS-only): an inline parser, not the `robots-parser` lib.
 * Fails OPEN on network/parse errors — a transient fetch failure must not silently
 * block all ingestion in the local prototype; it logs and allows.
 *
 * See docs/RESPONSIBLE-AI.md §8 (Copyright & TDM Policy).
 *
 * @author Radarist Team
 * @created 2026-06-06
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('tdm-policy');

/** The agent token Radarist identifies as (matched case-insensitively in robots groups). */
const USER_AGENT_TOKEN = 'radarist';
const FETCH_TIMEOUT_MS = 8000;

export interface TdmPolicyResult {
  allowed: boolean;
  /** Human-readable reason when `allowed` is false (used as the block reason). */
  reason?: string;
}

interface RobotsRule {
  allow: boolean;
  path: string;
}
interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `path` match a robots rule pattern (supports `*` wildcard and `$` end-anchor)? */
function pathMatches(path: string, rule: string): boolean {
  if (rule === '/') return true;
  const hasEnd = rule.endsWith('$');
  const core = hasEnd ? rule.slice(0, -1) : rule;
  const pattern = '^' + core.split('*').map(escapeRegex).join('.*') + (hasEnd ? '$' : '');
  try {
    return new RegExp(pattern).test(path);
  } catch {
    return path.startsWith(core.split('*')[0]);
  }
}

function parseGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'disallow' || field === 'allow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      current.rules.push({ allow: field === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function agentApplies(agent: string, specificOnly: boolean): boolean {
  if (agent === '*') return !specificOnly;
  // A malformed `User-agent:` line yields an empty token, and `''` is a substring
  // of everything — so without this guard an empty group reads as one that NAMES
  // us, and a `Disallow: /` under it refuses a URL the user just pasted. Harmless
  // while this only ran in a background job; a user-visible 403 now that the
  // check gates first ingest.
  if (!agent) return false;
  return USER_AGENT_TOKEN.includes(agent) || agent.includes(USER_AGENT_TOKEN);
}

export interface IsDisallowedOptions {
  /**
   * Ignore the catch-all `User-agent: *` group; only a group that NAMES our
   * agent counts. See {@link checkTdmPolicy} for why robots.txt is read this
   * way and ai.txt is not.
   */
  requireNamedAgent?: boolean;
}

/**
 * Decide whether `path` is disallowed for our agent (or `*`) by a robots/ai.txt body.
 * Most-specific-agent group wins; within it, the longest matching rule decides
 * (Allow beats Disallow on equal length). An empty `Disallow:` means allow-all.
 */
export function isDisallowed(body: string, path: string, options: IsDisallowedOptions = {}): boolean {
  const groups = parseGroups(body);
  const specific = groups.filter((g) => g.agents.some((a) => agentApplies(a, true)));
  const applicable = specific.length
    ? specific
    : options.requireNamedAgent
      ? []
      : groups.filter((g) => g.agents.some((a) => agentApplies(a, false)));
  if (!applicable.length) return false;

  let decision: { allow: boolean; len: number } | null = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (rule.path === '') continue; // empty Disallow → allow all (no constraint)
      if (!pathMatches(path, rule.path)) continue;
      const len = rule.path.length;
      if (!decision || len > decision.len || (len === decision.len && rule.allow)) {
        decision = { allow: rule.allow, len };
      }
    }
  }
  return decision ? !decision.allow : false;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;

    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Radarist/1.0 (TDM policy check)' },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Check a URL against the site's TDM opt-out signals before ingestion.
 * Returns `{ allowed: false, reason }` if robots.txt or ai.txt reserves the path.
 *
 * **What counts as a rights reservation** (one rule, applied by every ingestion
 * path — first ingest, reprocess, and the scheduled refresh):
 *
 * - `robots.txt` — only a group that NAMES our agent (`User-agent: Radarist`).
 *   A blanket `User-agent: * / Disallow: /` is a *crawl* directive: it is how a
 *   great many ordinary sites tell search engines to go away, and reading it as
 *   an Art 4(3) TDM reservation would refuse to ingest a URL a human operator
 *   just pasted, for a page they are already looking at in their browser. The
 *   DSM Directive asks for a reservation that is *express*; a site-wide crawler
 *   block is not one.
 * - `ai.txt` / `.well-known/ai.txt` — ANY group, including `*`. This file has no
 *   purpose other than reserving rights against text-and-data mining, so `*`
 *   here IS the express reservation that `*` in robots.txt is not.
 *
 * This is a policy judgment, not a legal opinion, and it is deliberately the
 * narrower of the two readings. It is recorded in docs/RESPONSIBLE-AI.md §8 so
 * the choice is visible rather than buried in a regex.
 *
 * Fails OPEN on network/parse errors — see the file header.
 */
export async function checkTdmPolicy(url: string): Promise<TdmPolicyResult> {
  let origin: string;
  let path: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    path = parsed.pathname + parsed.search;
  } catch {
    return { allowed: true }; // unparseable → fail open
  }

  const [robots, aiTxt, wellKnownAiTxt] = await Promise.all([
    fetchText(`${origin}/robots.txt`),
    fetchText(`${origin}/ai.txt`),
    fetchText(`${origin}/.well-known/ai.txt`),
  ]);

  // requireNamedAgent: a blanket `*` block is a crawl directive, not an express
  // TDM reservation. See the doc comment above.
  if (robots && isDisallowed(robots, path, { requireNamedAgent: true })) {
    log.info('TDM opt-out via robots.txt', { url });
    return { allowed: false, reason: 'TDM opt-out: robots.txt disallows this path for our agent (Radarist)' };
  }

  const ai = aiTxt ?? wellKnownAiTxt;
  if (ai && isDisallowed(ai, path)) {
    log.info('TDM opt-out via ai.txt', { url });
    return { allowed: false, reason: 'TDM opt-out: ai.txt reserves this content from text/data mining (DSM Art 4(3))' };
  }

  return { allowed: true };
}
