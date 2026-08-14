/**
 * @file lib/user-preferences.ts
 * @description Passive preference harvester — learns what the user wants
 * and how they want it from their mission history, without any explicit
 * profile form.
 *
 * The harvester runs nightly (via an Inngest cron) and writes
 * `userPreferences/{uid}` in Firestore. The orchestrator reads it at
 * mission-dispatch time and injects a USER PROFILE block into the
 * prompt preamble so the agent sees the context without the user
 * restating preferences every time.
 */

import { db } from './firebase-admin';
import { createLogger } from './logger';
import type { PinnedPreferences, UserPreferences } from './schemas/user-preferences';
import { pinnedPreferencesSchema, userPreferencesSchema } from './schemas/user-preferences';

const log = createLogger('user-preferences');

const COLLECTION = 'userPreferences';
const MISSIONS_COLLECTION = 'missions';
const HARVEST_WINDOW_DAYS = 30;
const MIN_MISSIONS_FOR_CONFIDENCE = 5;
const STRUCTURE_MAJORITY_THRESHOLD = 0.6;
const CITATION_MAJORITY_THRESHOLD = 0.4;
const CONFIDENCE_REQUESTS_THRESHOLD = 0.4;
const TOP_AGENTS_N = 5;
const TOP_TOPICS_N = 10;

// ---------------------------------------------------------------------------
// Pattern detectors — kept private here to decouple from mission-quality.ts
// ---------------------------------------------------------------------------

function mentionsImrad(prompt: string): boolean {
  return /\b(IMRAD|whitepaper|methods and results|discussion and references|scientific.{0,20}report)\b/i.test(prompt);
}
function mentionsSbar(prompt: string): boolean {
  return /\b(SBAR|situation.{0,20}background.{0,20}assessment|executive brief|1-pager|one[-\s]pager)\b/i.test(prompt);
}
function mentionsRadar(prompt: string): boolean {
  return /\bradar report|landscape report|technology radar\b/i.test(prompt);
}
function expectsCitations(prompt: string): boolean {
  return /\b(cit(e|ation|ations)|IEEE|references?\b|DOI|arxiv)\b/i.test(prompt);
}
function expectsConfidence(prompt: string): boolean {
  return /\b(confidence|calibrated|Admiralty|reliability score|uncertainty)\b/i.test(prompt);
}

/**
 * Extract capitalized multi-word phrases from a prompt as a rough topic proxy.
 * Stop-list filters out common sentence starters.
 */
const STOP_PHRASES = new Set([
  'User Profile',
  'User Context',
  'Mission',
  'Quality',
  'Use Case',
  'Results',
  'Methods',
  'Introduction',
  'Discussion',
  'References',
  'Analysis',
  'Report',
  'Strategic',
  'Tactical',
]);

/**
 * Verbs / sentence-start words frequently appearing before the real topic.
 * Stripped from the head of a matched phrase so "Analyze Anthropic Claude"
 * becomes "Anthropic Claude".
 */
const LEADING_STOPWORDS = new Set([
  'Analyze',
  'Produce',
  'Generate',
  'Report',
  'Create',
  'Find',
  'Follow',
  'Check',
  'Review',
  'Give',
  'Provide',
  'Build',
  'Write',
  'Show',
  'Get',
  'Identify',
  'Summarize',
  'Evaluate',
  'Compare',
  'Audit',
  'Research',
  'Describe',
  'Explain',
]);

function extractTopicPhrases(prompt: string): string[] {
  // Allow mixed-case words (OpenAI) AND acronyms (GPT, API) — the head must
  // start with an uppercase letter, followed by at least one letter of any
  // case. Topics need ≥2 words so we also require {1,3} additional words.
  const matches = prompt.match(/\b([A-Z][A-Za-z]{1,}(?:\s+[A-Z][A-Za-z]{1,}){1,3})\b/g) ?? [];
  return matches
    .map((m) => {
      // Strip leading verbs so "Analyze Anthropic Claude" → "Anthropic Claude".
      const words = m.split(/\s+/);
      while (words.length >= 2 && LEADING_STOPWORDS.has(words[0])) {
        words.shift();
      }
      return words.length >= 2 ? words.join(' ') : '';
    })
    .filter((m) => m.length > 0 && !STOP_PHRASES.has(m) && m.length <= 40);
}

// ---------------------------------------------------------------------------
// Harvester
// ---------------------------------------------------------------------------

export interface HarvesterMission {
  prompt: string;
  agent: string;
  createdAt?: string;
}

/**
 * Pure harvester — computes UserPreferences from a list of missions. Exposed
 * separately so unit tests can feed synthetic missions without Firestore.
 */
export function harvestUserPreferencesFromList(userId: string, missions: HarvesterMission[]): UserPreferences {
  const now = new Date().toISOString();
  const n = missions.length;

  if (n === 0) {
    return {
      userId,
      updatedAt: now,
      missionsAnalyzed: 0,
      structureConfidence: 0,
      requestsConfidenceScores: false,
      preferredAgents: [],
      topTopics: [],
      avgPromptLength: 0,
    };
  }

  // Structure detection
  const imradCount = missions.filter((m) => mentionsImrad(m.prompt)).length;
  const sbarCount = missions.filter((m) => mentionsSbar(m.prompt)).length;
  const radarCount = missions.filter((m) => mentionsRadar(m.prompt)).length;

  type StructureKey = 'IMRAD' | 'SBAR' | 'radar';
  const structureCounts: Array<{ structure: StructureKey; count: number }> = [
    { structure: 'IMRAD' as StructureKey, count: imradCount },
    { structure: 'SBAR' as StructureKey, count: sbarCount },
    { structure: 'radar' as StructureKey, count: radarCount },
  ].sort((a, b) => b.count - a.count);

  const topStructure = structureCounts[0];
  const topShare = topStructure.count / n;
  const preferredStructure = topShare >= STRUCTURE_MAJORITY_THRESHOLD ? topStructure.structure : undefined;
  const structureConfidence = topShare;

  // Citation detection — pass if a sufficient share of prompts explicitly
  // request citations.
  const citationShare = missions.filter((m) => expectsCitations(m.prompt)).length / n;
  const preferredCitationStyle = citationShare >= CITATION_MAJORITY_THRESHOLD ? 'IEEE' : undefined;

  // Confidence-scores detection
  const confidenceShare = missions.filter((m) => expectsConfidence(m.prompt)).length / n;
  const requestsConfidenceScores = confidenceShare >= CONFIDENCE_REQUESTS_THRESHOLD;

  // Preferred agents — top N by count
  const agentCounts = new Map<string, number>();
  for (const m of missions) {
    const k = m.agent.toLowerCase();
    agentCounts.set(k, (agentCounts.get(k) ?? 0) + 1);
  }
  const preferredAgents = [...agentCounts.entries()]
    .map(([agent, count]) => ({ agent, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_AGENTS_N);

  // Top topics — frequency-sort capitalized phrases
  const topicCounts = new Map<string, number>();
  for (const m of missions) {
    for (const phrase of extractTopicPhrases(m.prompt)) {
      topicCounts.set(phrase, (topicCounts.get(phrase) ?? 0) + 1);
    }
  }
  const topTopics = [...topicCounts.entries()]
    .filter(([, c]) => c >= 2) // only phrases mentioned ≥2 times
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_TOPICS_N)
    .map(([phrase]) => phrase);

  const avgPromptLength = Math.round(missions.reduce((a, b) => a + b.prompt.length, 0) / n);

  return {
    userId,
    updatedAt: now,
    missionsAnalyzed: n,
    preferredStructure,
    structureConfidence,
    preferredCitationStyle,
    requestsConfidenceScores,
    preferredAgents,
    topTopics,
    avgPromptLength,
  };
}

/**
 * Full harvester — reads the last 30 days of missions for a user from
 * Firestore, runs the pure harvester, writes to userPreferences/{uid}.
 */
export async function harvestUserPreferences(userId: string): Promise<UserPreferences> {
  const cutoff = new Date(Date.now() - HARVEST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const snap = await db
    .collection(MISSIONS_COLLECTION)
    .where('userId', '==', userId)
    .where('createdAt', '>=', cutoff)
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();

  const missions: HarvesterMission[] = snap.docs.map((d) => {
    const data = d.data() as { prompt?: string; agent?: string; createdAt?: string };
    return {
      prompt: data.prompt ?? '',
      agent: data.agent ?? 'unknown',
      createdAt: data.createdAt,
    };
  });

  const prefs = harvestUserPreferencesFromList(userId, missions);

  // AI-005 — the nightly harvest is a full-doc rewrite, but the `pinned`
  // sub-object is EXPLICIT user input (set via PATCH /api/user/preferences),
  // not harvested state. TRANSACTIONAL read-modify-write (adversarial #2): a
  // plain get→set left a millisecond window where a pin clicked mid-harvest
  // was clobbered — exactly the bug class AI-005 exists to kill.
  const docRef = db.collection(COLLECTION).doc(userId);
  let pinnedPreserved = false;
  const written = await db.runTransaction(async (tx) => {
    const existingDoc = await tx.get(docRef);
    let existingPinned: PinnedPreferences | undefined;
    if (existingDoc.exists) {
      const pinnedCandidate = (existingDoc.data() as { pinned?: unknown } | undefined)?.pinned;
      const pinnedParse = pinnedPreferencesSchema.safeParse(pinnedCandidate);
      if (pinnedParse.success) {
        existingPinned = sanitizePinned(pinnedParse.data);
      } else if (pinnedCandidate !== undefined) {
        // A user-set pin failing validation is user-data loss — never silent.
        log.warn('Dropping schema-invalid pinned preferences during harvest', { userId });
      }
    }
    const parsed = userPreferencesSchema.parse(existingPinned ? { ...prefs, pinned: existingPinned } : prefs);
    // Firestore rejects `undefined`; Zod.parse keeps optional fields at undefined
    // rather than stripping them, so drop them here before writing.
    const sanitized = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined));
    tx.set(docRef, sanitized);
    pinnedPreserved = existingPinned !== undefined;
    return parsed;
  });
  log.info('Harvested user preferences', {
    userId,
    missionsAnalyzed: prefs.missionsAnalyzed,
    preferredStructure: prefs.preferredStructure,
    structureConfidence: prefs.structureConfidence,
    pinnedPreserved,
  });
  return written;
}

// ---------------------------------------------------------------------------
// Pinned preferences (AI-005 — explicit user overrides over harvested values)
// ---------------------------------------------------------------------------

/** Drop undefined members so Firestore never sees `undefined` and an all-empty pin object collapses away. */
function sanitizePinned(pinned: PinnedPreferences): PinnedPreferences | undefined {
  const entries = Object.entries(pinned).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as PinnedPreferences) : undefined;
}

/**
 * Per-field pin update: a concrete value SETS the pin, `null` CLEARS it,
 * an absent field leaves the existing pin untouched.
 */
export interface PinnedPreferenceUpdates {
  preferredStructure?: PinnedPreferences['preferredStructure'] | null;
  preferredCitationStyle?: PinnedPreferences['preferredCitationStyle'] | null;
  requestsConfidenceScores?: boolean | null;
}

/**
 * Set/clear explicit pins on `userPreferences/{uid}` (AI-005). When no harvest
 * has run yet, an empty-harvest stub document is created so the pins have a
 * schema-valid home; the nightly harvester later fills the learned fields in
 * around them (see harvestUserPreferences' read-modify-write).
 */
export async function setPinnedPreferences(userId: string, updates: PinnedPreferenceUpdates): Promise<UserPreferences> {
  const docRef = db.collection(COLLECTION).doc(userId);
  // Transactional for the same reason as the harvest (adversarial #2): a
  // harvest landing between this get and set must not be resurrected stale.
  const next = await db.runTransaction(async (tx) => {
    const existingDoc = await tx.get(docRef);
    const base: UserPreferences = existingDoc.exists
      ? userPreferencesSchema.parse(existingDoc.data())
      : harvestUserPreferencesFromList(userId, []);

    const nextPinned: Record<string, unknown> = { ...(base.pinned ?? {}) };
    for (const key of ['preferredStructure', 'preferredCitationStyle', 'requestsConfidenceScores'] as const) {
      if (!(key in updates)) continue;
      const value = updates[key];
      if (value === null) {
        delete nextPinned[key];
      } else if (value !== undefined) {
        nextPinned[key] = value;
      }
    }

    const pinned = sanitizePinned(pinnedPreferencesSchema.parse(nextPinned));
    const merged = userPreferencesSchema.parse({ ...base, pinned });
    const sanitized = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
    tx.set(docRef, sanitized);
    return merged;
  });
  log.info('Pinned preferences updated', { userId, pinnedFields: Object.keys(next.pinned ?? {}) });
  return next;
}

/**
 * Reset the stored preferences entirely (AI-005 — the Settings "Reset" action).
 * Deletes the Firestore doc; the nightly harvest recreates the learned fields.
 * Pins are explicit state and are deliberately deleted too — reset means reset.
 */
export async function resetUserPreferences(userId: string): Promise<void> {
  await db.collection(COLLECTION).doc(userId).delete();
  log.info('User preferences reset', { userId });
}

/**
 * Read the current preferences for a user. Returns null if no harvest has
 * been run yet (fresh users).
 */
export async function getMissionUserPreferences(userId: string): Promise<UserPreferences | null> {
  const doc = await db.collection(COLLECTION).doc(userId).get();
  if (!doc.exists) return null;
  return userPreferencesSchema.parse(doc.data());
}

/**
 * Build a preamble block to inject into the mission prompt. Returns an
 * empty string when there isn't enough signal to be useful (fewer than
 * MIN_MISSIONS_FOR_CONFIDENCE harvested, or no dominant preference).
 *
 * Output is capped at 500 chars to avoid drowning the actual prompt.
 */
export function buildUserPreferencesPreamble(prefs: UserPreferences | null | undefined): string {
  if (!prefs) return '';
  const pinned = prefs.pinned;
  const hasPins = pinned !== undefined && Object.values(pinned).some((v) => v !== undefined);
  // Harvested lines need enough mission history to be trustworthy; PINNED
  // values are explicit user input (AI-005) and are never confidence-gated.
  if (prefs.missionsAnalyzed < MIN_MISSIONS_FOR_CONFIDENCE && !hasPins) return '';
  const harvestTrusted = prefs.missionsAnalyzed >= MIN_MISSIONS_FOR_CONFIDENCE;

  const lines: string[] = ['USER PROFILE (learned from your last 30-day mission history):'];

  // Concrete definition of each structure so the agent can actually switch
  // templates rather than just borrowing the vocabulary.
  const STRUCTURE_GUIDE: Record<string, string> = {
    SBAR: 'Situation, Background, Assessment, Recommendation — exactly four named sections, concise (≈1 page), no other sections',
    IMRAD: 'Introduction, Methods, Results, Discussion — scientific-report shape',
    radar: 'a technology-radar landscape organized by Adopt / Trial / Assess / Hold rings',
  };

  // Pinned wins over harvested (AI-005). A pin of 'none' (or `false` for
  // confidence scores) is an explicit "no preference" — it SUPPRESSES the
  // harvested line rather than falling back to it.
  const structurePinned = pinned?.preferredStructure !== undefined;
  const effectiveStructure = structurePinned
    ? pinned.preferredStructure
    : harvestTrusted
      ? prefs.preferredStructure
      : undefined;

  if (effectiveStructure && effectiveStructure !== 'none') {
    const guide = STRUCTURE_GUIDE[effectiveStructure] ?? `${effectiveStructure} structure`;
    const label = structurePinned ? 'PINNED STRUCTURE (explicitly set by the user)' : 'DEFAULT STRUCTURE (learned)';
    const strength = structurePinned
      ? `This is an EXPLICIT, pinned preference — honor it unless the current prompt specifies its own format, structure, ` +
        `layout, sections, theme, background, color, or styling, in which case that explicit request WINS.`
      : `This is a learned default, NOT a hard rule — if the current prompt specifies ANY format, structure, ` +
        `layout, sections, theme, background, color, or styling, that explicit request WINS and you follow it instead.`;
    lines.push(
      `- ${label}: when the current request does NOT specify its own format/structure, ` +
        `produce the FINAL report in ${effectiveStructure} format (${guide}). ${strength}`
    );
  }

  const citationPinned = pinned?.preferredCitationStyle !== undefined;
  const effectiveCitation = citationPinned
    ? pinned.preferredCitationStyle
    : harvestTrusted
      ? prefs.preferredCitationStyle
      : undefined;
  const confidencePinned = pinned?.requestsConfidenceScores !== undefined;
  const effectiveConfidenceScores = confidencePinned
    ? pinned.requestsConfidenceScores
    : harvestTrusted
      ? prefs.requestsConfidenceScores
      : false;

  const extras: string[] = [];
  if (effectiveCitation === 'IEEE') extras.push(`IEEE citations${citationPinned ? ' (pinned)' : ''}`);
  if (effectiveConfidenceScores) extras.push(`calibrated confidence scores${confidencePinned ? ' (pinned)' : ''}`);
  if (extras.length > 0) lines.push(`- Include ${extras.join(' and ')}.`);

  if (harvestTrusted && prefs.topTopics.length > 0) {
    const topics = prefs.topTopics.slice(0, 4).join(', ');
    lines.push(`- Recent focus areas: ${topics}.`);
  }

  if (harvestTrusted && prefs.preferredAgents.length > 0) {
    const top = prefs.preferredAgents[0];
    const share = Math.round((top.count / prefs.missionsAnalyzed) * 100);
    if (share >= 40) lines.push(`- You use ${top.agent} most often (${share}% of recent missions).`);
  }

  if (lines.length === 1) return ''; // only header — no signal

  lines.push(
    'These are LEARNED DEFAULTS from past missions' +
      (hasPins ? ' (items marked "pinned" are EXPLICIT user settings, not learned)' : '') +
      '. The user’s CURRENT request always overrides them on any ' +
      'conflict (format, structure, layout, sections, theme, background, color, styling); apply a learned default ' +
      'only where the current request is silent.'
  );
  const block = lines.join('\n') + '\n\n';
  // Cap bounds the preamble so it never drowns the actual prompt, while staying
  // generous enough not to truncate the structure/precedence directive.
  const CAP = 1100;
  return block.length > CAP ? block.slice(0, CAP - 5).trimEnd() + '…\n\n' : block;
}
