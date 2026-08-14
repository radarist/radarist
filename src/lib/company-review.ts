/**
 * @file lib/company-review.ts
 * @description AI-043 — the ONE pure, client-safe derivation for the auditable
 * human source-review workflow over a company research draft.
 *
 * A company can carry TWO distinct, independently-versioned research artifacts:
 *  - `narrative`   — `company.research` (the 12-section `CompanyResearch` block
 *                    the Research tab renders; version = `research.version`);
 *  - `structured`  — `company.aiResearch` (the AI-028 provenance: per-claim
 *                    receipts + honest gaps; version = `aiResearch.lastResearched`).
 * They are never mixed. The projection reviews the ONE artifact the Research tab
 * actually displays (narrative first, else structured), matching
 * `deriveCompanyResearchPresentation`.
 *
 * Every reviewable area carries a stable **content digest** that binds the exact
 * bounded claim/section VALUE and the FULL source-receipt identity (url + title +
 * publisher + date) — not the URL alone. A decision is bound to the artifact
 * kind/version, the whole-draft digest, and the area digest, so ANY change to the
 * draft (a changed value, a same-URL receipt-content change, a new/removed source,
 * a new contradiction/gap) stales prior decisions. Stale decisions are preserved
 * as history but never counted toward readiness.
 *
 * Readiness is DERIVED here, never stored and never directly writable. Hard
 * blockers — contradictions, missing-evidence gaps, incomplete sourcing, and
 * legacy value-less claims — can NEVER be approved away; while any is present in
 * the current draft the draft is not ready.
 *
 * Pure and client-safe: reads plain fields off a `Company`-shaped object and
 * imports no server-only modules. The digest is a deterministic
 * non-cryptographic content hash (change-detection, not tamper-resistance) so it
 * is identical in the browser, the Node API/repository path and tests.
 * Canonical-field promotion is a SEPARATE action — approving a review never
 * writes a Company field.
 */

import type { Company, CompanyResearch } from '@/lib/types';
import { canonicalHttpUrl } from '@/lib/signals/source-identity';
import { hasRenderableResearchSections, RENDERABLE_RESEARCH_SECTIONS } from '@/lib/company-research-presentation';
import { companyIndustrySchema, companySizeSchema, companyStageSchema } from '@/lib/schemas/company';

/** The three verdicts a human reviewer may record for an area. */
export const COMPANY_REVIEW_DECISIONS = ['approved', 'rejected', 'needs_changes'] as const;
export type CompanyReviewDecision = (typeof COMPANY_REVIEW_DECISIONS)[number];

/** Which research artifact a review targets. Never mixed. */
export type CompanyReviewArtifactKind = 'structured' | 'narrative';

/** What kind of reviewable unit an area is. */
export type CompanyReviewAreaKind = 'claim' | 'section';

/** A hard readiness blocker — present in the current draft, not approvable away. */
export type CompanyReviewBlockerKind =
  | 'contradiction'
  | 'evidenceGap'
  | 'unknownFact'
  | 'sourcingIncomplete'
  | 'unreviewable'
  | 'invalidValue'
  | 'tooManySources'
  | 'noReviewableContent';

/**
 * ONE source bound used consistently across the projection, the UI, the API
 * schema, and the persisted decision. An area that binds more than this many
 * distinct sources is a HARD blocker (never silently truncated), so a reviewer
 * always sees every source their decision binds and every server projection is
 * accepted by the decision schema.
 */
export const MAX_REVIEW_SOURCES = 20;
const MAX_SOURCE_LABEL_LENGTH = 300;
const MAX_SOURCE_URL_LENGTH = 2048;
const MAX_NOTE_LENGTH = 2000;
const MAX_VALUE_LENGTH = 8000;

/** Bounded, safe source reference with FULL identity — never fetched server-side. */
export interface CompanyReviewSourceReceipt {
  /** Content digest of the full receipt (url + title + publisher + date). */
  identity: string;
  label: string;
  /** Present only for a valid absolute http(s) URL; else the ref is plain text. */
  url?: string;
  title?: string;
  publisher?: string;
  published?: string;
}

/** One reviewable unit of the displayed artifact. */
export interface CompanyReviewArea {
  /** Stable key, e.g. `size` (structured) or `executiveSummary` (narrative). */
  key: string;
  kind: CompanyReviewAreaKind;
  label: string;
  /** Bounded reviewed value. Absent means the value cannot be proven → unreviewable. */
  value?: string;
  /** False for a legacy value-less claim that cannot prove what was reviewed. */
  reviewable: boolean;
  /** Full source-receipt identities backing this area at this version. */
  sourceReceipts: CompanyReviewSourceReceipt[];
  /** Sorted, de-duplicated receipt identity digests (bound into the area digest). */
  sourceIds: string[];
  /** Content digest binding kind + version + value + full receipts. */
  areaDigest: string;
}

/** A hard blocker surfaced for display; never an approvable area. */
export interface CompanyReviewBlocker {
  kind: CompanyReviewBlockerKind;
  label: string;
  detail?: string;
}

/** The full derived review projection of a company's displayed draft. */
export interface CompanyReviewProjection {
  companyId: string;
  hasDraft: boolean;
  /** The artifact being reviewed, or null when there is nothing to review. */
  artifactKind: CompanyReviewArtifactKind | null;
  /** Explicit artifact version (stringified), '' when no draft. */
  artifactVersion: string;
  /** Whole-draft version digest — changes on ANY content/area/blocker change. */
  draftDigest: string;
  lastResearchedAt?: number;
  /** Approvable claim/section areas. */
  areas: CompanyReviewArea[];
  /** Hard readiness blockers present in the current draft. */
  blockers: CompanyReviewBlocker[];
  /** The draft's own honest sourcing flag — informational only, never "verified". */
  sourcingComplete: boolean;
}

/**
 * A durable, recorded review decision. `ownerId`, `reviewerId`, `createdAt` and
 * the event `id` are all server-resolved — a client never chooses them.
 */
export interface CompanyReviewEvent {
  id: string;
  companyId: string;
  ownerId: string;
  reviewerId: string;
  artifactKind: CompanyReviewArtifactKind;
  artifactVersion: string;
  area: string;
  areaDigest: string;
  draftDigest: string;
  sourceIds: string[];
  decision: CompanyReviewDecision;
  note?: string;
  createdAt: number;
}

/** The derived, never-stored readiness of a draft for a single owner. */
export interface CompanyReviewReadiness {
  ready: boolean;
  requiredCount: number;
  approvedCount: number;
  /** Reviewable areas with no current decision. */
  uncoveredAreas: string[];
  /** Reviewable areas whose current decision is rejected / needs_changes. */
  blockedAreas: string[];
  /** Hard blockers (contradictions/gaps/sourcing/unreviewable) present in the draft. */
  hardBlockers: CompanyReviewBlocker[];
  /** Human-readable blockers for display. */
  reasons: string[];
}

// ============================================================================
// Deterministic content digest (pure, environment-agnostic)
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON with object keys sorted recursively, so a digest is invariant
 * to key insertion order. Array order is preserved (source arrays are sorted by
 * the caller before hashing, so a genuine add/remove/change still moves the
 * digest while a pure reorder does not).
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return 'null';
}

// Minimal, dependency-free, COLLISION-RESISTANT SHA-256 (FIPS 180-4). Pure JS so
// it is byte-identical in the browser, the Node API/repository path and tests —
// a digest computed on the server matches the client. Change-detection over the
// COMPLETE canonical artifact, not truncated material.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function utf8Bytes(message: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < message.length; i += 1) {
    const c = message.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0xd800 || c >= 0xe000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else {
      i += 1;
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (message.charCodeAt(i) & 0x3ff));
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return bytes;
}

export function sha256Hex(message: string): string {
  const bytes = utf8Bytes(message);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  bytes.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] =
        (bytes[i + t * 4] << 24) | (bytes[i + t * 4 + 1] << 16) | (bytes[i + t * 4 + 2] << 8) | bytes[i + t * 4 + 3];
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[t] + w[t]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * Deterministic, collision-resistant content digest over a value. Prefixed with a
 * format version so a digest-format change is visible in stored decisions.
 */
export function contentDigest(value: unknown): string {
  return `v3-${sha256Hex(stableStringify(value))}`;
}

// ============================================================================
// Labels + bounded helpers
// ============================================================================

const CLAIM_AREA_LABELS: Record<string, string> = {
  description: 'Description',
  website: 'Website',
  size: 'Company size',
  stage: 'Funding stage',
  industries: 'Industries',
  technologyStack: 'Technology stack',
  city: 'City',
  country: 'Country',
};

function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? bounded(normalized, max) : undefined;
}

function safeUrl(value: unknown) {
  if (typeof value !== 'string' || value.trim().length > MAX_SOURCE_URL_LENGTH) return null;
  return canonicalHttpUrl(value);
}

function urlLabel(displayUrl: string): string {
  try {
    const parsed = new URL(displayUrl);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return bounded(`${parsed.host}${path}`, MAX_SOURCE_LABEL_LENGTH);
  } catch {
    return bounded(displayUrl, MAX_SOURCE_LABEL_LENGTH);
  }
}

interface ResolvedSources {
  /** Sorted, de-duplicated FULL source identities (every bound source, not a sample). */
  ids: string[];
  /** Display receipts — one per identity, in identity order (never count-truncated). */
  receipts: CompanyReviewSourceReceipt[];
  /** True when the area binds MORE than MAX_REVIEW_SOURCES distinct sources. */
  overLimit: boolean;
}

/** Sort receipts by their bound identity so display order matches `ids`. */
function finalizeSources(map: Map<string, CompanyReviewSourceReceipt>): ResolvedSources {
  const ids = [...map.keys()].sort();
  return { ids, receipts: ids.map((id) => map.get(id)!), overLimit: ids.length > MAX_REVIEW_SOURCES };
}

/**
 * Reduce a raw structured receipt array to sorted FULL identities + display
 * receipts. Identity binds url + title + publisher + date, so a same-URL content
 * change (a re-titled/re-dated citation) produces a different identity. EVERY
 * distinct safe source is kept — the count is never silently truncated; an
 * over-the-bound area is surfaced as a hard blocker by the projection.
 */
function resolveStructuredSources(sources: unknown): ResolvedSources {
  const byIdentity = new Map<string, CompanyReviewSourceReceipt>();
  if (!Array.isArray(sources)) return { ids: [], receipts: [], overLimit: false };

  for (const source of sources) {
    if (!isRecord(source)) continue;
    const url = safeUrl(source.url);
    if (!url) continue;
    const title = boundedText(source.title, MAX_SOURCE_LABEL_LENGTH);
    const publisher = boundedText(source.publisher, MAX_SOURCE_LABEL_LENGTH);
    const published = boundedText(source.publishedDate, 60);
    const identity = contentDigest({
      url: url.displayUrl,
      title: title ?? null,
      publisher: publisher ?? null,
      published: published ?? null,
    });
    if (byIdentity.has(identity)) continue;
    const label =
      title && publisher && title.toLocaleLowerCase() !== publisher.toLocaleLowerCase()
        ? bounded(`${title} — ${publisher}`, MAX_SOURCE_LABEL_LENGTH)
        : (title ?? publisher ?? urlLabel(url.displayUrl));
    byIdentity.set(identity, {
      identity,
      label,
      url: url.displayUrl,
      ...(title ? { title } : {}),
      ...(publisher ? { publisher } : {}),
      ...(published ? { published } : {}),
    });
  }
  return finalizeSources(byIdentity);
}

/**
 * Reduce a narrative `metadata.sources` list to sorted identities + refs. Only a
 * VERIFIABLE safe http(s) URL counts as a reviewable source — a free-text citation
 * or an unsafe URL (e.g. `javascript:`) cannot be checked by a reviewer, so it
 * does not make a section reviewable. Every distinct safe URL is kept.
 */
function resolveNarrativeSources(sources: unknown): ResolvedSources {
  const byIdentity = new Map<string, CompanyReviewSourceReceipt>();
  if (!Array.isArray(sources)) return { ids: [], receipts: [], overLimit: false };

  for (const raw of sources) {
    const url = safeUrl(raw);
    if (!url) continue;
    const identity = contentDigest({ url: url.displayUrl });
    if (byIdentity.has(identity)) continue;
    byIdentity.set(identity, { identity, label: urlLabel(url.displayUrl), url: url.displayUrl });
  }
  return finalizeSources(byIdentity);
}

// ============================================================================
// Canonical claim-value validation (promotion-exactness gate)
// ============================================================================

/**
 * Split a comma/semicolon/newline list into trimmed, non-empty members. Used for
 * `industries` / `technologyStack`, which promote onto `Company.industry` /
 * `Company.technologyStack` arrays.
 */
export function splitClaimList(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The exact Company field a canonical claim promotes onto, and the value written. */
export interface CompanyFieldWrite {
  field: 'description' | 'website' | 'size' | 'stage' | 'industry' | 'technologyStack' | 'city' | 'country';
  /** Written verbatim — a string for scalar fields, a member array for list fields. */
  value: string | string[];
}

/**
 * THE single mapping from a structured claim (key, COMPLETE value) to the exact
 * Company field write. Returns `null` when the value is NOT something strict
 * promotion would write UNCHANGED — an out-of-enum size, an unknown industry, an
 * unsafe/unparseable website, or a key that maps to no Company field. Because both
 * reviewability (this returning non-null) and promotion (writing this `field`/`value`)
 * go through this one function on the SAME complete value, reviewability accepts
 * EXACTLY what strict promotion writes — no wider, no narrower, never truncated,
 * never coerced into a different value.
 */
export function canonicalCompanyFieldWrite(key: string, value: string): CompanyFieldWrite | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  switch (key) {
    case 'description':
      return { field: 'description', value: trimmed };
    case 'website': {
      const url = safeUrl(trimmed);
      return url ? { field: 'website', value: url.displayUrl } : null;
    }
    case 'size':
      return companySizeSchema.safeParse(trimmed).success ? { field: 'size', value: trimmed } : null;
    case 'stage':
      return companyStageSchema.safeParse(trimmed).success ? { field: 'stage', value: trimmed } : null;
    case 'industries': {
      const members = splitClaimList(trimmed);
      return members.length > 0 && members.every((m) => companyIndustrySchema.safeParse(m).success)
        ? { field: 'industry', value: members }
        : null;
    }
    case 'technologyStack': {
      const members = splitClaimList(trimmed);
      return members.length > 0 ? { field: 'technologyStack', value: members } : null;
    }
    case 'city':
      return { field: 'city', value: trimmed };
    case 'country':
      return { field: 'country', value: trimmed };
    default:
      // Not a promotable Company field — nothing strict promotion would write, so
      // it is NOT reviewable (it becomes an unreviewable hard blocker instead).
      return null;
  }
}

/**
 * Is `value` reviewable+promotable for claim `key`? True IFF strict promotion would
 * write it unchanged (see {@link canonicalCompanyFieldWrite}). The reviewer never
 * approves one value and has a different (coerced, truncated, or unsafe) value
 * promoted.
 */
export function isCanonicalClaimValue(key: string, value: string): boolean {
  return canonicalCompanyFieldWrite(key, value) !== null;
}

function makeArea(
  key: string,
  areaKind: CompanyReviewAreaKind,
  artifactKind: CompanyReviewArtifactKind,
  artifactVersion: string,
  label: string,
  /** Bounded value returned/displayed. */
  displayValue: string | undefined,
  /** COMPLETE canonical value the immutable digest is computed from (never truncated). */
  digestValue: string | undefined,
  sources: ResolvedSources,
  /** Caller's verdict: value known AND source-backed AND canonical AND within source bound. */
  reviewable: boolean
): CompanyReviewArea {
  return {
    key,
    kind: areaKind,
    label,
    ...(displayValue !== undefined ? { value: displayValue } : {}),
    reviewable,
    sourceReceipts: sources.receipts,
    sourceIds: sources.ids,
    areaDigest: contentDigest({
      artifactKind,
      artifactVersion,
      key,
      kind: areaKind,
      // Digest the COMPLETE value so two drafts differing only after the display
      // bound (e.g. character 8,000) never collide onto the same digest.
      value: digestValue ?? null,
      // Bind EVERY source identity (not a truncated sample) so adding/removing any
      // source moves the digest and stales a prior decision.
      sourceIds: sources.ids,
    }),
  };
}

// ============================================================================
// Projection
// ============================================================================

/** Read the COMPLETE claim-value snapshot from the persisted provenance (untruncated). */
function claimValue(claimValues: unknown, key: string): string | undefined {
  if (!isRecord(claimValues)) return undefined;
  const raw = claimValues[key];
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return undefined;
  return stableStringify(raw);
}

/**
 * The COMPLETE, untruncated structured claim value the review projection reviewed
 * for `key` — the EXACT value promotion must write (never the display-bounded one).
 * Reads through the same extraction as {@link buildCompanyReviewProjection}.
 */
export function structuredClaimValue(aiResearch: Company['aiResearch'] | undefined, key: string): string | undefined {
  const data = aiResearch && isRecord(aiResearch.data) ? aiResearch.data : undefined;
  if (!data) return undefined;
  const claimValues = isRecord(data.claimValues) ? data.claimValues : {};
  return claimValue(claimValues, key);
}

function buildStructuredProjection(
  companyId: string,
  aiResearch: NonNullable<Company['aiResearch']>
): CompanyReviewProjection {
  const data = isRecord(aiResearch.data) ? aiResearch.data : {};
  const artifactKind: CompanyReviewArtifactKind = 'structured';
  const lastResearchedAt = typeof aiResearch.lastResearched === 'number' ? aiResearch.lastResearched : undefined;
  const explicitVersion = typeof data.version === 'number' ? data.version : lastResearchedAt;
  const artifactVersion = String(explicitVersion ?? 0);
  const claimValues = isRecord(data.claimValues) ? data.claimValues : {};
  const receipts = isRecord(data.receipts) ? data.receipts : {};

  const areas: CompanyReviewArea[] = [];
  const blockers: CompanyReviewBlocker[] = [];

  // FAIL CLOSED: derive an area for EVERY claim the draft asserts — the union of
  // value-bearing keys and receipt-bearing keys. A claim that carries a value but
  // no source (or a source but no value, or a non-canonical/over-bound value) is
  // NOT silently dropped; it becomes an unreviewable area AND a hard blocker, so
  // the draft can never reach `ready` by approving only the well-formed subset.
  const claimKeys = new Set<string>([...Object.keys(claimValues), ...Object.keys(receipts)]);
  for (const key of [...claimKeys].sort()) {
    const sources = resolveStructuredSources(receipts[key]);
    const full = claimValue(claimValues, key);
    const display = full !== undefined ? bounded(full, MAX_VALUE_LENGTH) : undefined;
    const label = CLAIM_AREA_LABELS[key] ?? key;

    const hasValue = full !== undefined;
    const hasSource = sources.ids.length > 0;
    const canonical = hasValue && isCanonicalClaimValue(key, full);
    const reviewable = hasValue && hasSource && canonical && !sources.overLimit;

    areas.push(makeArea(key, 'claim', artifactKind, artifactVersion, label, display, full, sources, reviewable));

    if (!reviewable) {
      if (sources.overLimit) {
        blockers.push({
          kind: 'tooManySources',
          label: `${label} binds too many sources`,
          detail: `A single claim may bind at most ${MAX_REVIEW_SOURCES} distinct sources (found ${sources.ids.length}). Re-research to consolidate them.`,
        });
      } else if (!hasValue) {
        blockers.push({
          kind: 'unreviewable',
          label: `${label} cannot be reviewed`,
          detail: 'This claim has a source but no recorded value — re-research the company to review it.',
        });
      } else if (!hasSource) {
        blockers.push({
          kind: 'sourcingIncomplete',
          label: `${label} has no source`,
          detail: 'A claim can be reviewed only when it cites at least one safe source. Re-research to add sources.',
        });
      } else {
        blockers.push({
          kind: 'invalidValue',
          label: `${label} has an unpromotable value`,
          detail: `The recorded value "${bounded(full, 120)}" is not a valid ${label.toLowerCase()} — approving it would promote a different value. Re-research to correct it.`,
        });
      }
    }
  }

  // Contradictions and evidence gaps are HARD blockers, never approvable. Their
  // full text feeds the whole-artifact draft digest below (never truncated there).
  if (Array.isArray(data.contradictions)) {
    for (const raw of data.contradictions) {
      if (!isRecord(raw) || typeof raw.field !== 'string') continue;
      const field = bounded(raw.field, 120);
      const values = Array.isArray(raw.values)
        ? raw.values.filter((v): v is string => typeof v === 'string').map((v) => bounded(v, 300))
        : [];
      blockers.push({ kind: 'contradiction', label: `Contradiction: ${field}`, detail: values.join(' | ') });
    }
  }
  const missingEvidence: string[] = [];
  if (Array.isArray(data.missingEvidence)) {
    for (const raw of data.missingEvidence) {
      if (typeof raw !== 'string') continue;
      const category = bounded(raw.trim(), 40);
      if (!category || missingEvidence.includes(category)) continue;
      missingEvidence.push(category);
      blockers.push({ kind: 'evidenceGap', label: `Missing evidence: ${category}` });
    }
  }

  // Every field research explicitly declared UNKNOWN (could not source) is a hard
  // blocker — a persisted unknown fact keeps the draft not-ready and can never be
  // approved away, exactly like an unsourced claim value above.
  const unknowns: string[] = [];
  if (Array.isArray(data.unknowns)) {
    for (const raw of data.unknowns) {
      if (typeof raw !== 'string') continue;
      const field = bounded(raw.trim(), 60);
      if (!field || unknowns.includes(field)) continue;
      unknowns.push(field);
      blockers.push({ kind: 'unknownFact', label: `Unknown: ${CLAIM_AREA_LABELS[field] ?? field}` });
    }
  }

  // DERIVED, not trusted: sourcing is complete only when every asserted claim is
  // reviewable and no contradiction/evidence-gap blocker is present. The draft's
  // own stored `sourcingComplete` boolean is never believed for readiness — it is
  // digested (below) purely so a change to it moves the draft digest.
  const hasDraft = areas.length > 0;
  const sourcingComplete = hasDraft && blockers.length === 0;

  // Whole-artifact digest: binds the COMPLETE raw payload (contradiction tails,
  // every evidence-gap category, confidence, model, the stored sourcing flag …)
  // plus each area digest and full blocker text. ANY content change stales every
  // prior decision.
  const draftDigest = contentDigest({
    artifactKind,
    artifactVersion,
    payload: data,
    areas: areas.map((area) => ({ key: area.key, areaDigest: area.areaDigest })),
    blockers: blockers.map((b) => ({ kind: b.kind, label: b.label, detail: b.detail ?? null })),
    sourcingComplete,
  });

  return {
    companyId,
    hasDraft,
    artifactKind,
    artifactVersion,
    draftDigest,
    ...(lastResearchedAt !== undefined ? { lastResearchedAt } : {}),
    areas,
    blockers,
    sourcingComplete,
  };
}

/** The single reviewable-area key for a narrative draft. */
export const NARRATIVE_AREA_KEY = 'narrative';

function buildNarrativeProjection(companyId: string, research: CompanyResearch): CompanyReviewProjection {
  const artifactKind: CompanyReviewArtifactKind = 'narrative';
  const artifactVersion = String(typeof research.version === 'number' ? research.version : 0);
  const lastResearchedAt = typeof research.lastResearched === 'number' ? research.lastResearched : undefined;
  // The whole narrative draft cites ONE flat `metadata.sources` list — so it is a
  // SINGLE review unit, not one shared-source area per section (approving one
  // section's sources cannot meaningfully differ from approving another's).
  const sources = resolveNarrativeSources(research.metadata?.sources);

  // Collect every renderable section verbatim into one canonical value. Each
  // section keeps its own label→content pair so a change to any one section (even
  // past the display bound) moves the area/draft digest.
  const sectionEntries: Array<[string, unknown]> = [];
  for (const section of RENDERABLE_RESEARCH_SECTIONS) {
    const content = research[section];
    if (!content) continue;
    sectionEntries.push([section, content]);
  }

  const areas: CompanyReviewArea[] = [];
  const blockers: CompanyReviewBlocker[] = [];
  const hasContent = sectionEntries.length > 0;

  if (hasContent) {
    const canonical = stableStringify(Object.fromEntries(sectionEntries)); // COMPLETE value
    const display = bounded(canonical, MAX_VALUE_LENGTH);
    const reviewable = sources.ids.length > 0 && !sources.overLimit;
    areas.push(
      makeArea(
        NARRATIVE_AREA_KEY,
        'section',
        artifactKind,
        artifactVersion,
        'Narrative research',
        display,
        canonical,
        sources,
        reviewable
      )
    );
    if (!reviewable) {
      if (sources.overLimit) {
        blockers.push({
          kind: 'tooManySources',
          label: 'Narrative research binds too many sources',
          detail: `A narrative draft may bind at most ${MAX_REVIEW_SOURCES} distinct sources (found ${sources.ids.length}). Re-research to consolidate them.`,
        });
      } else {
        blockers.push({
          kind: 'sourcingIncomplete',
          label: 'Narrative research has no reviewable source',
          detail:
            'A narrative draft can be reviewed only when it cites at least one safe source. Re-research to add sources.',
        });
      }
    }
  }

  // DERIVED: sourcing is complete only when the draft has content and no blocker.
  const sourcingComplete = hasContent && blockers.length === 0;

  // Whole-artifact digest binds the COMPLETE research payload (all sections,
  // metadata sources, confidence, model) so any content change stales decisions.
  const draftDigest = contentDigest({
    artifactKind,
    artifactVersion,
    payload: research,
    areas: areas.map((area) => ({ key: area.key, areaDigest: area.areaDigest })),
    blockers: blockers.map((b) => ({ kind: b.kind, label: b.label, detail: b.detail ?? null })),
    sourcingComplete,
  });

  return {
    companyId,
    hasDraft: hasContent,
    artifactKind,
    artifactVersion,
    draftDigest,
    ...(lastResearchedAt !== undefined ? { lastResearchedAt } : {}),
    areas,
    blockers,
    sourcingComplete,
  };
}

function emptyProjection(companyId: string): CompanyReviewProjection {
  return {
    companyId,
    hasDraft: false,
    artifactKind: null,
    artifactVersion: '',
    draftDigest: contentDigest({ empty: true }),
    areas: [],
    blockers: [{ kind: 'noReviewableContent', label: 'No research draft to review yet.' }],
    sourcingComplete: false,
  };
}

/**
 * Derive the review projection for the ONE artifact the Research tab displays:
 * the narrative draft when it has renderable sections, else the structured draft.
 * Never mixes provenance from the two artifacts.
 */
export function buildCompanyReviewProjection(
  company: Pick<Company, 'id' | 'research' | 'aiResearch'>
): CompanyReviewProjection {
  const companyId = company.id;
  if (hasRenderableResearchSections(company.research) && company.research) {
    return buildNarrativeProjection(companyId, company.research);
  }
  if (company.aiResearch && isRecord(company.aiResearch.data)) {
    const structured = buildStructuredProjection(companyId, company.aiResearch);
    if (structured.hasDraft) return structured;
  }
  return emptyProjection(companyId);
}

// ============================================================================
// Readiness (derived, never stored)
// ============================================================================

/**
 * The latest CURRENT decision for an area — the most recent event that matches
 * the area's current digest AND the draft's kind/version/digest. Events under an
 * older draft are stale history and are ignored. Equal timestamps break
 * deterministically on event id.
 */
export function currentDecisionForArea(
  area: Pick<CompanyReviewArea, 'key' | 'areaDigest'>,
  projection: Pick<CompanyReviewProjection, 'artifactKind' | 'artifactVersion' | 'draftDigest'>,
  events: readonly CompanyReviewEvent[]
): CompanyReviewEvent | undefined {
  let latest: CompanyReviewEvent | undefined;
  for (const event of events) {
    if (
      event.area !== area.key ||
      event.areaDigest !== area.areaDigest ||
      event.draftDigest !== projection.draftDigest ||
      event.artifactKind !== projection.artifactKind ||
      event.artifactVersion !== projection.artifactVersion
    ) {
      continue;
    }
    if (
      !latest ||
      event.createdAt > latest.createdAt ||
      (event.createdAt === latest.createdAt && event.id > latest.id)
    ) {
      latest = event;
    }
  }
  return latest;
}

/** True when the event does not correspond to the current draft version. */
export function isStaleEvent(event: CompanyReviewEvent, projection: CompanyReviewProjection): boolean {
  if (event.artifactKind !== projection.artifactKind || event.artifactVersion !== projection.artifactVersion) {
    return true;
  }
  if (event.draftDigest !== projection.draftDigest) return true;
  return !projection.areas.some((area) => area.key === event.area && area.areaDigest === event.areaDigest);
}

/**
 * Derive readiness purely from the current projection and this owner's events.
 * Hard blockers (contradictions, gaps, incomplete sourcing, unreviewable legacy
 * claims) can never be approved away and keep a draft not-ready while present.
 */
export function deriveCompanyReviewReadiness(
  projection: CompanyReviewProjection,
  events: readonly CompanyReviewEvent[]
): CompanyReviewReadiness {
  const reviewableAreas = projection.areas.filter((area) => area.reviewable);
  const uncoveredAreas: string[] = [];
  const blockedAreas: string[] = [];
  let approvedCount = 0;

  for (const area of reviewableAreas) {
    const current = currentDecisionForArea(area, projection, events);
    if (!current) {
      uncoveredAreas.push(area.key);
      continue;
    }
    if (current.decision === 'approved') approvedCount += 1;
    else blockedAreas.push(area.key);
  }

  const reasons: string[] = [];
  if (!projection.hasDraft) reasons.push('No research draft to review yet.');
  for (const blocker of projection.blockers) reasons.push(blocker.label);
  if (reviewableAreas.length === 0 && projection.hasDraft) reasons.push('No reviewable source-backed claims.');
  if (uncoveredAreas.length > 0) reasons.push(`${uncoveredAreas.length} area(s) not yet reviewed.`);
  if (blockedAreas.length > 0) reasons.push(`${blockedAreas.length} area(s) rejected or need changes.`);

  const ready =
    projection.hasDraft &&
    projection.blockers.length === 0 &&
    reviewableAreas.length > 0 &&
    uncoveredAreas.length === 0 &&
    blockedAreas.length === 0;

  return {
    ready,
    requiredCount: reviewableAreas.length,
    approvedCount,
    uncoveredAreas,
    blockedAreas,
    hardBlockers: projection.blockers,
    reasons,
  };
}

/** Bound and normalize an optional reviewer note. Returns undefined for empty. */
export function normalizeReviewNote(note: unknown): string | undefined {
  if (typeof note !== 'string') return undefined;
  const trimmed = note.trim();
  return trimmed ? bounded(trimmed, MAX_NOTE_LENGTH) : undefined;
}

// ============================================================================
// Review status (for the review queue/facet)
// ============================================================================

export type CompanyReviewStatus = 'none' | 'not_reviewed' | 'partial' | 'blocked' | 'stale' | 'ready';

/**
 * Classify a company's CURRENT review state for one owner. Drives the review
 * queue so a completed (ready) or draft-less (none) company leaves the queue,
 * while an incomplete one is shown with the reason it is incomplete.
 */
export function classifyCompanyReviewStatus(
  projection: CompanyReviewProjection,
  events: readonly CompanyReviewEvent[]
): CompanyReviewStatus {
  if (!projection.hasDraft) return 'none';
  const readiness = deriveCompanyReviewReadiness(projection, events);
  if (readiness.ready) return 'ready';
  // A hard blocker OR any CURRENT rejected / needs_changes area → blocked (never
  // "partial", which would understate a draft a reviewer has actively turned back).
  if (projection.blockers.length > 0 || readiness.blockedAreas.length > 0) return 'blocked';
  // Some reviewable areas approved, others still uncovered → partial.
  if (readiness.approvedCount > 0) return 'partial';
  if (events.some((event) => isStaleEvent(event, projection))) return 'stale';
  return 'not_reviewed';
}

/** True when a status means the draft still needs review (belongs in the queue). */
export function isIncompleteReviewStatus(status: CompanyReviewStatus): boolean {
  return status === 'not_reviewed' || status === 'partial' || status === 'blocked' || status === 'stale';
}
