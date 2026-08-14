/**
 * @file radar-resolver-admin.ts
 * @description The ONE exact radar resolver shared by every Assistant placement
 * tool (AI-022).
 *
 * Resolution contract:
 * 1. stable document ID first (exact),
 * 2. then UNIQUE normalized exact display name (NFKC, trim, collapse inner
 *    whitespace, case-insensitive),
 * 3. a missing reference resolves only when exactly one radar exists
 *    (deterministic, not a guess),
 * 4. everything else fails closed with candidates for clarification —
 *    ambiguity, absence, and fuzzy/partial matches never write anything.
 */

import 'server-only';

import { adminGetRadarById, adminListRadars } from '@/lib/radars-admin';
import type { RadarData } from '@/lib/types';

export interface RadarCandidate {
  id: string;
  name: string;
}

export type RadarResolutionFailureReason = 'missing-reference' | 'not-found' | 'ambiguous';

export interface RadarResolutionFailure {
  ok: false;
  reason: RadarResolutionFailureReason;
  /** Honest, user-presentable explanation including the candidates to pick from. */
  message: string;
  candidates: RadarCandidate[];
}

export interface RadarResolutionSuccess {
  ok: true;
  radar: RadarData;
  matchedBy: 'id' | 'exact-name' | 'only-radar';
}

export type RadarResolution = RadarResolutionSuccess | RadarResolutionFailure;

/** Normalized exact-name key: NFKC, trimmed, inner whitespace collapsed, lowercased. */
export function normalizeRadarName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function toCandidates(radars: RadarData[]): RadarCandidate[] {
  return radars.map((radar) => ({ id: radar.id, name: radar.name }));
}

function candidateList(candidates: RadarCandidate[]): string {
  return candidates.map((candidate) => `"${candidate.name}" (${candidate.id})`).join(', ');
}

/**
 * Resolve a radar reference (stable ID or exact display name) to one radar.
 *
 * Never guesses: an ambiguous or unknown reference returns a failure carrying
 * the candidates so the Assistant can ask the user to clarify — callers must
 * write NOTHING on failure.
 */
export async function resolveRadarReference(reference: string | undefined | null): Promise<RadarResolution> {
  const trimmed = typeof reference === 'string' ? reference.trim() : '';

  if (!trimmed) {
    const radars = await adminListRadars();
    if (radars.length === 1) {
      return { ok: true, radar: radars[0], matchedBy: 'only-radar' };
    }
    return {
      ok: false,
      reason: 'missing-reference',
      message:
        radars.length === 0
          ? 'No radars exist yet. Create a radar first.'
          : `No radar was specified and ${radars.length} radars exist — ask the user which one to use: ${candidateList(toCandidates(radars))}.`,
      candidates: toCandidates(radars),
    };
  }

  const byId = await adminGetRadarById(trimmed);
  if (byId) {
    return { ok: true, radar: byId, matchedBy: 'id' };
  }

  const radars = await adminListRadars();
  const normalizedReference = normalizeRadarName(trimmed);
  const matches = radars.filter((radar) => normalizeRadarName(radar.name) === normalizedReference);

  if (matches.length === 1) {
    return { ok: true, radar: matches[0], matchedBy: 'exact-name' };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `The radar name "${trimmed}" matches ${matches.length} radars — ask the user which exact radar (by ID): ${candidateList(toCandidates(matches))}. Nothing was changed.`,
      candidates: toCandidates(matches),
    };
  }
  return {
    ok: false,
    reason: 'not-found',
    message:
      radars.length === 0
        ? `No radar matches "${trimmed}" — no radars exist yet.`
        : `No radar matches "${trimmed}" by ID or exact name. Available radars: ${candidateList(toCandidates(radars))}. Nothing was changed.`,
    candidates: toCandidates(radars),
  };
}
