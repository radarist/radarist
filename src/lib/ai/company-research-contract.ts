/**
 * @file ai/company-research-contract.ts
 * @description AI-028 — the bounded persistence boundary for comprehensive company research.
 *
 * The previous boundary generated free-text prose and then recovered "facts" by
 * scanning it: `lowerResponse.includes('enterprise')` set company size,
 * `includes('public')` set funding stage (matching "public cloud" and "publicly
 * available"), an 18-country regex set the HQ country, and a case-sensitive
 * substring list set the tech stack (`'Go'` matched "Google"). Worse, the values
 * it produced were not even members of the target unions — `'SME'`,
 * `'Series A'` and `'AI'` were cast straight onto `CompanySize`, `CompanyStage`
 * and `CompanyIndustry`, none of which contain them.
 *
 * This module replaces that boundary with:
 *
 *  1. **A bounded Zod schema over the REAL enums.** The model must emit
 *     `medium` / `series_b` / `technology`; `'SME'` is a validation error, not a
 *     silent cast. Every string and array is length-capped.
 *  2. **Claim-level source receipts.** Each atomic fact carries its own sources.
 *     A fact is persisted ONLY when at least one of its sources is a
 *     structurally valid absolute http(s) URL without embedded credentials.
 *     Unsourced facts are recorded as unknowns instead of being written.
 *  3. **Preserved unknowns and contradictions.** A field the model reports as
 *     contradicted is never persisted — keeping the disagreement visible beats
 *     silently picking a side.
 *  4. **Honest vendor capability status.** An `available` capability with no
 *     valid source is downgraded to `unknown`; `announced` is never read as
 *     available.
 *  5. **Derived missing-evidence naming.** The benchmark / pricing / SLA /
 *     security / trial gaps are computed from the evidence actually supplied,
 *     not taken on the model's word, so a recommendation always names what is
 *     missing.
 *
 * **Receipts are model-attributed, structurally validated, and never fetched.**
 * `generateStructuredContent` does not surface Gemini grounding citations (it
 * only extracts them on the plain-text path), so a receipt proves the model
 * cited a well-formed publisher URL — not that the URL exists or supports the
 * claim. No URL is ever requested; SECURITY.md defines the trust boundary.
 *
 * @author Radarist Team
 * @created 2026-07-19
 */

import { z } from 'zod';

import { canonicalHttpUrl } from '@/lib/signals/source-identity';
import type { CompanyIndustry, CompanySize, CompanyStage } from '@/lib/types';

/** Real `CompanySize` members — the schema accepts nothing else. */
export const COMPANY_SIZE_VALUES = ['micro', 'small', 'medium', 'large', 'enterprise'] as const;

/** Real `CompanyStage` members. */
export const COMPANY_STAGE_VALUES = [
  'pre_seed',
  'seed',
  'series_a',
  'series_b',
  'series_c_plus',
  'bootstrapped',
  'private',
  'public',
  'ipo',
  'nonprofit',
] as const;

/** Real `CompanyIndustry` members. */
export const COMPANY_INDUSTRY_VALUES = [
  'healthcare',
  'food_agriculture',
  'technology',
  'manufacturing',
  'energy',
  'consumer',
  'financial',
  'logistics',
  'media',
  'professional',
  'defense',
  'education',
  'real_estate',
  'telecommunications',
  'automotive',
  'chemicals',
  'other',
] as const;

/**
 * Evidence classes a vendor recommendation must be able to point at. A gap in
 * any of these is named explicitly rather than glossed over.
 */
export const COMPANY_EVIDENCE_CATEGORIES = ['benchmark', 'pricing', 'sla', 'security', 'trial'] as const;

export type CompanyEvidenceCategory = (typeof COMPANY_EVIDENCE_CATEGORIES)[number];

/** A single source receipt attached to one claim. */
export const companyResearchSourceSchema = z.object({
  // Deliberately NOT `.min(1)`: models routinely emit "" for "no source", and a
  // single empty string would fail the whole-payload parse and discard every
  // well-sourced claim alongside it. `validSources` rejects "" anyway.
  url: z.string().max(2048),
  title: z.string().max(300).optional(),
  publisher: z.string().max(200).optional(),
  publishedDate: z.string().max(40).optional(),
});

export type CompanyResearchSource = z.infer<typeof companyResearchSourceSchema>;

/** Wrap a value schema in a claim that must carry its own receipts. */
function sourcedClaim<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({
      value: valueSchema,
      sources: z.array(companyResearchSourceSchema).max(5).default([]),
    })
    .nullable()
    .default(null);
}

const evidenceListSchema = z.array(companyResearchSourceSchema).max(5).default([]);

/**
 * The bounded shape `generateStructuredContent` must return. Every field
 * defaults to "absent" so a model that omits a section produces unknowns rather
 * than defaults that read as findings.
 */
export const comprehensiveCompanyResearchSchema = z.object({
  name: z.string().min(1).max(200),

  description: sourcedClaim(z.string().max(6000)),
  website: sourcedClaim(z.string().max(2048)),
  size: sourcedClaim(z.enum(COMPANY_SIZE_VALUES)),
  stage: sourcedClaim(z.enum(COMPANY_STAGE_VALUES)),
  city: sourcedClaim(z.string().max(120)),
  country: sourcedClaim(z.string().max(120)),
  industries: sourcedClaim(z.array(z.enum(COMPANY_INDUSTRY_VALUES)).max(5)),
  technologyStack: sourcedClaim(z.array(z.string().max(60)).max(25)),

  socialLinks: z
    .object({
      linkedin: z.string().max(2048).optional(),
      twitter: z.string().max(2048).optional(),
      github: z.string().max(2048).optional(),
    })
    .default({}),

  contacts: z
    .array(
      z.object({
        name: z.string().max(120),
        role: z.string().max(160),
        linkedin: z.string().max(2048).optional(),
        sources: z.array(companyResearchSourceSchema).max(3).default([]),
      })
    )
    .max(10)
    .default([]),

  // Competitors are sourced claims: a name plus the citations the model offered
  // for the competitive relationship. Unsourced names still surface (for triage)
  // but reach the proposal with no evidence rather than a fabricated one.
  competitors: z
    .array(
      z.object({
        name: z.string().max(120),
        sources: z.array(companyResearchSourceSchema).max(3).default([]),
      })
    )
    .max(15)
    .default([]),

  swot: z
    .object({
      strengths: z.array(z.string().max(400)).max(6).default([]),
      weaknesses: z.array(z.string().max(400)).max(6).default([]),
      opportunities: z.array(z.string().max(400)).max(6).default([]),
      threats: z.array(z.string().max(400)).max(6).default([]),
    })
    .default({ strengths: [], weaknesses: [], opportunities: [], threats: [] }),

  /** Fields the model looked for and could not establish. */
  unknowns: z.array(z.string().max(120)).max(30).default([]),

  /** Fields where sources disagree. Persisting either side would be a lie. */
  contradictions: z
    .array(
      z.object({
        field: z.string().max(120),
        values: z.array(z.string().max(300)).max(5),
        sources: z.array(companyResearchSourceSchema).max(5).default([]),
      })
    )
    .max(10)
    .default([]),

  vendorCapabilities: z
    .array(
      z.object({
        name: z.string().max(160),
        status: z.enum(['available', 'announced', 'unknown']),
        sources: z.array(companyResearchSourceSchema).max(3).default([]),
      })
    )
    .max(20)
    .default([]),

  /** Sources per evidence class, used to derive what is missing. */
  evidenceByCategory: z
    .object({
      benchmark: evidenceListSchema,
      pricing: evidenceListSchema,
      sla: evidenceListSchema,
      security: evidenceListSchema,
      trial: evidenceListSchema,
    })
    .default({ benchmark: [], pricing: [], sla: [], security: [], trial: [] }),
});

export type ComprehensiveCompanyResearch = z.infer<typeof comprehensiveCompanyResearchSchema>;

/** Facts cleared for persistence. Every present key has a receipt. */
export interface PersistableCompanyFacts {
  description?: string;
  website?: string;
  size?: CompanySize;
  stage?: CompanyStage;
  location?: { city?: string; country?: string };
  industries?: CompanyIndustry[];
  technologyStack?: string[];
  /** Only links that cleared the http(s) URL gate. */
  socialLinks?: { linkedin?: string; twitter?: string; github?: string };
}

export interface CompanyVendorCapability {
  name: string;
  status: 'available' | 'announced' | 'unknown';
  sources: CompanyResearchSource[];
}

export interface PersistableCompanyResearch {
  facts: PersistableCompanyFacts;
  /** Receipts keyed by the fact they support. */
  receipts: Record<string, CompanyResearchSource[]>;
  unknowns: string[];
  contradictions: ComprehensiveCompanyResearch['contradictions'];
  vendorCapabilities: CompanyVendorCapability[];
  missingEvidence: CompanyEvidenceCategory[];
  /**
   * True only when every evidence category carries at least one OFFERED
   * citation. Renamed from `decisionGrade`: it establishes that citations were
   * offered, NOT that they were fetched or that they support the claim.
   */
  sourcingComplete: boolean;
  /** Always false: receipts are model-offered, never fetched or verified. */
  citationsVerified: false;
}

/** Keep only sources whose URL is a usable absolute http(s) URL. */
function validSources(sources: readonly CompanyResearchSource[]): CompanyResearchSource[] {
  return sources.filter((source) => canonicalHttpUrl(source.url) !== null);
}

type Claim<T> = { value: T; sources: CompanyResearchSource[] } | null;

/**
 * Reduce a validated research payload to the facts that may actually be written.
 *
 * A claim survives only if it has at least one structurally valid source AND its
 * field is not listed as contradicted. Everything else becomes an unknown, so
 * absence of evidence is recorded as absence rather than as a default value.
 *
 * @param research - A payload already validated by `comprehensiveCompanyResearchSchema`.
 * @returns The persistable facts, their receipts, and the honest gaps.
 */
export function toPersistableCompanyFacts(research: ComprehensiveCompanyResearch): PersistableCompanyResearch {
  const facts: PersistableCompanyFacts = {};
  const receipts: Record<string, CompanyResearchSource[]> = {};
  const unknowns = new Set<string>(research.unknowns);
  const contradictedFields = new Set(research.contradictions.map((entry) => entry.field));

  /**
   * Accept a claim, or record why it was rejected.
   *
   * `apply` returns false when the value is itself unusable — an empty list, or
   * a URL-typed value that is not a safe http(s) URL. In that case the field is
   * an unknown and gets NO receipt: a receipt for a fact that was never written
   * is a false audit trail.
   */
  function accept<T>(field: string, claim: Claim<T>, apply: (value: T) => boolean): void {
    if (contradictedFields.has(field)) {
      unknowns.add(field);
      return;
    }
    if (claim === null) {
      unknowns.add(field);
      return;
    }
    const sources = validSources(claim.sources);
    if (sources.length === 0) {
      unknowns.add(field);
      return;
    }
    if (!apply(claim.value)) {
      unknowns.add(field);
      return;
    }
    receipts[field] = sources;
  }

  accept('description', research.description, (value) => {
    facts.description = value;
    return true;
  });
  // A URL-typed VALUE gets the same structural gate its sources get. Without
  // this a `javascript:` website reached Firestore with a receipt and was
  // rendered as a raw href.
  accept('website', research.website, (value) => {
    if (!canonicalHttpUrl(value)) return false;
    facts.website = value;
    return true;
  });
  accept('size', research.size, (value) => {
    facts.size = value;
    return true;
  });
  accept('stage', research.stage, (value) => {
    facts.stage = value;
    return true;
  });
  accept('industries', research.industries, (value) => {
    if (value.length === 0) return false;
    facts.industries = [...value];
    return true;
  });
  accept('technologyStack', research.technologyStack, (value) => {
    if (value.length === 0) return false;
    facts.technologyStack = [...value];
    return true;
  });

  const location: { city?: string; country?: string } = {};
  accept('city', research.city, (value) => {
    location.city = value;
    return true;
  });
  accept('country', research.country, (value) => {
    location.country = value;
    return true;
  });
  if (location.city !== undefined || location.country !== undefined) {
    facts.location = location;
  }

  // Social links are persisted straight onto the company and rendered as
  // hrefs, so each one must clear the same URL gate. Unusable links are dropped
  // rather than written.
  const socialLinks: { linkedin?: string; twitter?: string; github?: string } = {};
  for (const key of ['linkedin', 'twitter', 'github'] as const) {
    const value = research.socialLinks[key];
    if (typeof value === 'string' && canonicalHttpUrl(value)) socialLinks[key] = value;
  }
  if (Object.keys(socialLinks).length > 0) facts.socialLinks = socialLinks;

  // An `available` claim with no usable source is not a capability, it is a
  // hope. Announced stays announced — a roadmap item is not a shipped feature.
  const vendorCapabilities: CompanyVendorCapability[] = research.vendorCapabilities.map((capability) => {
    const sources = validSources(capability.sources);
    const status = capability.status === 'available' && sources.length === 0 ? 'unknown' : capability.status;
    return { name: capability.name, status, sources };
  });

  const missingEvidence = COMPANY_EVIDENCE_CATEGORIES.filter(
    (category) => validSources(research.evidenceByCategory[category]).length === 0
  );

  return {
    facts,
    receipts,
    unknowns: [...unknowns],
    contradictions: research.contradictions,
    vendorCapabilities,
    missingEvidence: [...missingEvidence],
    sourcingComplete: missingEvidence.length === 0,
    citationsVerified: false,
  };
}
