/**
 * @file lib/company-research-persistence.ts
 * @description AI-028 — the durable persistence boundary for sourced company
 * research.
 *
 * This is the sanctioned door for persisting a cleared research result onto a
 * company: it is the write path of the create-with-research assistant flow
 * (`executeCreateCompanyWithResearch`). Narrative-only refresh writers, which
 * persist the separate 12-section `company.research` block, are out of this
 * boundary's scope (their provenance is deferred with the narrative).
 *
 * AI-043 — DRAFT ONLY. Research NEVER writes canonical Company fields (size,
 * website, industry, …). It persists the provenance draft (receipts, contradictions,
 * missing-evidence, the honest sourcing grade) AND a bounded, receipt-gated snapshot
 * of the proposed claim values into the `aiResearch` sink. A proposed value becomes
 * a canonical Company field ONLY after a human records a source-review approval for
 * it and the explicit promotion action runs (`promoteApprovedCompanyReviewClaims`).
 * Persisting facts straight onto the Company here would bypass that review gate, so
 * it does not. Routing through here guarantees:
 *  - only sourced (receipt-backed) proposed values enter the reviewable draft;
 *  - the provenance block is persisted through the bounded `aiResearch` sink;
 *  - the caller always gets the authoritative persisted company back.
 *
 * Server-only: it writes through the admin SDK. Client callers reach it through
 * a server action, so all durable research persistence stays on the server and
 * on one contract.
 */

import 'server-only';

import { adminCreateCompany, adminGetCompanyById, adminUpdateCompany } from '@/lib/companies-admin';
import { createLogger } from '@/lib/logger';
import type { PersistableCompanyResearch } from '@/lib/ai/company-research-contract';
import type { Company } from '@/lib/types';

const log = createLogger('company-research-persistence');

type AdminCreateCompanyInput = Parameters<typeof adminCreateCompany>[0];

/** Where the sourced research is written. */
export type CompanyResearchTarget =
  { kind: 'create'; seed: AdminCreateCompanyInput } | { kind: 'update'; companyId: string };

export interface SourcedCompanyResearchInput {
  /** The cleared result of `toPersistableCompanyFacts`. */
  research: PersistableCompanyResearch;
  /** Competitor display names surfaced by research (persisted in provenance). */
  competitors?: string[];
}

/**
 * AI-043 — a bounded snapshot of EVERY extracted proposed claim value, keyed by the
 * same field as `receipts`. Fail-closed sourcing is enforced by the REVIEW
 * PROJECTION, not here: an extracted value that lacks a safe source is still
 * persisted so it becomes a VISIBLE, blocking area (an unsourced fact must block
 * readiness, never be silently dropped). The human source-review workflow binds a
 * decision to this exact value; the projection refuses to make an unsourced or
 * non-canonical one reviewable.
 */
function buildClaimValues(research: PersistableCompanyResearch): Record<string, string> {
  const { facts } = research;
  const values: Record<string, string> = {};
  const put = (key: string, value: string | undefined): void => {
    if (typeof value === 'string' && value.length > 0) values[key] = value.slice(0, 8000);
  };
  put('description', facts.description);
  put('website', facts.website);
  put('size', facts.size);
  put('stage', facts.stage);
  if (facts.industries && facts.industries.length > 0) put('industries', facts.industries.join(', '));
  if (facts.technologyStack && facts.technologyStack.length > 0)
    put('technologyStack', facts.technologyStack.join(', '));
  put('city', facts.location?.city);
  put('country', facts.location?.country);
  return values;
}

function buildProvenance(input: SourcedCompanyResearchInput): Company['aiResearch'] {
  const { research, competitors } = input;
  const now = Date.now();
  const claimValues = buildClaimValues(research);
  return {
    lastResearched: now,
    data: {
      receipts: research.receipts,
      unknowns: research.unknowns,
      contradictions: research.contradictions,
      vendorCapabilities: research.vendorCapabilities,
      missingEvidence: research.missingEvidence,
      sourcingComplete: research.sourcingComplete,
      citationsVerified: research.citationsVerified,
      // AI-043 — version + reviewed-value snapshot so the draft is reviewable.
      version: now,
      ...(Object.keys(claimValues).length > 0 ? { claimValues } : {}),
      ...(competitors ? { competitors } : {}),
    },
  };
}

/**
 * Persist a cleared company-research result as a DRAFT ONLY: the provenance block
 * plus a receipt-gated snapshot of the proposed claim values, written through the
 * bounded `aiResearch` sink. It NEVER writes canonical Company fields — those are
 * populated only by the explicit, human-reviewed promotion action. Returns the
 * authoritative persisted company.
 */
export async function persistSourcedCompanyResearch(
  target: CompanyResearchTarget,
  input: SourcedCompanyResearchInput
): Promise<Company> {
  const aiResearch = buildProvenance(input);

  if (target.kind === 'create') {
    // Draft only: the seed defines the Company; research populates aiResearch, not
    // canonical fields. Review + promotion is the only path to canonical fields.
    const company = await adminCreateCompany({ ...target.seed, aiResearch });
    log.info('Persisted sourced company research draft (create)', {
      companyId: company.id,
      sourcingComplete: input.research.sourcingComplete,
      unknowns: input.research.unknowns.length,
    });
    return company;
  }

  await adminUpdateCompany(target.companyId, { aiResearch });
  const persisted = await adminGetCompanyById(target.companyId);
  if (!persisted) {
    // The update may have committed; refuse to fabricate a return value.
    throw new Error(`Company ${target.companyId} not found after sourced-research update`);
  }
  log.info('Persisted sourced company research draft (update)', {
    companyId: target.companyId,
    sourcingComplete: input.research.sourcingComplete,
    unknowns: input.research.unknowns.length,
  });
  return persisted;
}
