/**
 * Research-tab refresh and review behavior against a real Firestore emulator.
 *
 * The NARRATIVE refresh writer can produce an artifact that is
 * unreviewable BY CONSTRUCTION. `resolveNarrativeSources` counts a source only
 * when it is a safe absolute http(s) URL (a free-text citation cannot be checked
 * by a human), while the generator's schema/prompt/example taught the model to
 * emit bare descriptions ("company website", "crunchbase"). Every refresh
 * therefore regenerated the same unreviewable draft and the blocker kept saying
 * "re-research to add sources" forever. `researchCompanyComprehensive` also
 * hardcoded `version: 1`, so a refreshed draft never became a new artifact
 * version.
 *
 * This suite drives the durable path: seed a synthetic stale shape, refresh, reload
 * from Firestore, review, approve, and assert the real promotion boundary. The
 * reviewer gate is NOT loosened anywhere — an unverifiable citation must stay
 * unreviewable, stale decisions must stay refused.
 *
 * Runs via `npm run test:emulator`, or standalone through
 * `firebase emulators:exec --only firestore,auth`.
 *
 * @jest-environment node
 */

import { db as adminDb } from '@/lib/firebase-admin';
import {
  recordCompanyReviewDecision,
  listCompanyReviewEvents,
  promoteApprovedCompanyReviewClaims,
  CompanyReviewStaleDraftError,
  CompanyReviewNotReadyError,
  CompanyReviewNotPromotableError,
  COMPANY_REVIEW_EVENTS_COLLECTION,
} from '@/lib/company-review-admin';
import {
  buildCompanyReviewProjection,
  deriveCompanyReviewReadiness,
  isStaleEvent,
  NARRATIVE_AREA_KEY,
} from '@/lib/company-review';
import type { CompanyReviewDecisionInput } from '@/lib/schemas/company-review';
import type { Company, CompanyResearch } from '@/lib/types';

const COMPANY_ID = 'refresh-review-emu-co';
const ALICE = { ownerId: 'alice-refresh-emu', reviewerId: 'alice-refresh-emu' };
const recordedIds = new Set<string>();

/** A narrative draft shaped exactly like the generator produces. */
function narrativeDraft(version: number, sources: string[]): CompanyResearch {
  return {
    lastResearched: 1_700_000_000 + version,
    version,
    executiveSummary: { overview: `Overview revision ${version}`, suggestedTags: ['sustainability'] },
    riskAssessment: { vendorRiskScore: 25, financialHealth: 'strong' },
    metadata: { sources, confidenceScore: 85, model: 'gemini-3.1-pro-preview' },
  } as unknown as CompanyResearch;
}

function companyDoc(research: CompanyResearch, overrides: Record<string, unknown> = {}): Company {
  return {
    id: COMPANY_ID,
    name: 'Refresh Acme',
    description: '',
    website: '',
    type: ['sme'],
    industry: [],
    location: { city: '', country: '' },
    status: 'Watching',
    tags: [],
    socialLinks: {},
    technologyStack: [],
    documents: [],
    createdAt: 1,
    updatedAt: 1,
    research,
    ...overrides,
  } as unknown as Company;
}

async function seed(company: Company): Promise<void> {
  await adminDb
    .collection('companies')
    .doc(COMPANY_ID)
    .set(company as unknown as Record<string, unknown>);
}

/** Reload the company from Firestore exactly as a page reload would. */
async function reload(): Promise<Company> {
  const snap = await adminDb.collection('companies').doc(COMPANY_ID).get();
  return snap.data() as Company;
}

function narrativeApproval(company: Company, overrides: Partial<CompanyReviewDecisionInput> = {}) {
  const projection = buildCompanyReviewProjection(company);
  const area = projection.areas.find((a) => a.key === NARRATIVE_AREA_KEY)!;
  return {
    companyId: COMPANY_ID,
    artifactKind: 'narrative' as const,
    artifactVersion: projection.artifactVersion,
    area: NARRATIVE_AREA_KEY,
    areaDigest: area.areaDigest,
    draftDigest: projection.draftDigest,
    sourceIds: area.sourceIds,
    decision: 'approved' as const,
    idempotencyKey: 'refresh-emu-approve',
    ...overrides,
  } satisfies CompanyReviewDecisionInput;
}

async function approve(company: Company, overrides: Partial<CompanyReviewDecisionInput> = {}) {
  const result = await recordCompanyReviewDecision(narrativeApproval(company, overrides), ALICE);
  recordedIds.add(result.event.id);
  return result;
}

beforeEach(async () => {
  const existing = await adminDb
    .collection(COMPANY_REVIEW_EVENTS_COLLECTION)
    .where('companyId', '==', COMPANY_ID)
    .get();
  await Promise.all(existing.docs.map((docSnap) => docSnap.ref.delete()));
});

afterAll(async () => {
  await Promise.all(
    [...recordedIds].map((id) =>
      adminDb
        .collection(COMPANY_REVIEW_EVENTS_COLLECTION)
        .doc(id)
        .delete()
        .catch(() => undefined)
    )
  );
  await adminDb
    .collection('companies')
    .doc(COMPANY_ID)
    .delete()
    .catch(() => undefined);
  await adminDb.terminate();
});

describe('AI-043 — retained narrative draft: refresh -> reload -> review -> approve', () => {
  it('reproduces the dead end: a free-text-sourced draft is unreviewable and cannot be approved', async () => {
    await seed(companyDoc(narrativeDraft(1, ['company website', 'crunchbase', 'linkedin'])));

    const company = await reload();
    const projection = buildCompanyReviewProjection(company);
    const readiness = deriveCompanyReviewReadiness(projection, []);

    expect(projection.hasDraft).toBe(true);
    expect(projection.areas.filter((a) => a.reviewable)).toHaveLength(0);
    expect(projection.blockers.map((b) => b.kind)).toContain('sourcingIncomplete');
    expect(readiness.ready).toBe(false);
    expect(readiness.requiredCount).toBe(0);

    // The gate stays closed: an unreviewable area cannot be approved into readiness.
    await expect(recordCompanyReviewDecision(narrativeApproval(company), ALICE)).rejects.toBeInstanceOf(
      CompanyReviewStaleDraftError
    );
    await expect(promoteApprovedCompanyReviewClaims(COMPANY_ID, ALICE.ownerId)).rejects.toBeInstanceOf(
      CompanyReviewNotReadyError
    );
  });

  it('refresh -> reload -> review -> approve now reaches ready on the durable document', async () => {
    await seed(companyDoc(narrativeDraft(1, ['company website', 'crunchbase'])));

    // Refresh: the fixed generator contract persists URL sources and a NEW version.
    const refreshed = narrativeDraft(2, ['https://acme.example/about', 'https://www.sec.gov/acme']);
    await adminDb.collection('companies').doc(COMPANY_ID).update({ research: refreshed });

    // Reload — everything below is derived from what Firestore actually holds.
    const company = await reload();
    const projection = buildCompanyReviewProjection(company);

    expect(projection.artifactKind).toBe('narrative');
    expect(projection.artifactVersion).toBe('2');
    expect(projection.blockers).toHaveLength(0);
    expect(projection.areas.filter((a) => a.reviewable)).toHaveLength(1);

    const { event, outcome } = await approve(company);
    expect(outcome).toBe('recorded');
    expect(event.artifactVersion).toBe('2');

    const events = await listCompanyReviewEvents(COMPANY_ID, ALICE.ownerId);
    expect(deriveCompanyReviewReadiness(projection, events).ready).toBe(true);
  });

  it('keeps a narrative draft reviewed-for-trust only — promotion stays explicitly refused', async () => {
    await seed(companyDoc(narrativeDraft(2, ['https://acme.example/about'])));

    const company = await reload();
    await approve(company);
    const events = await listCompanyReviewEvents(COMPANY_ID, ALICE.ownerId);
    expect(deriveCompanyReviewReadiness(buildCompanyReviewProjection(company), events).ready).toBe(true);

    // A narrative draft has no canonical field mapping. Refusing is the contract —
    // it must never report a hollow success or invent a Company field write.
    await expect(promoteApprovedCompanyReviewClaims(COMPANY_ID, ALICE.ownerId)).rejects.toBeInstanceOf(
      CompanyReviewNotPromotableError
    );
    const after = await reload();
    expect(after.description ?? '').toBe('');
  });
});

describe('AI-043 — stale refusal and cross-turn retry on the refreshed draft', () => {
  it('refuses an approval bound to the pre-refresh draft, then accepts the re-derived one', async () => {
    await seed(companyDoc(narrativeDraft(2, ['https://acme.example/about'])));
    const loaded = await reload();
    const staleInput = narrativeApproval(loaded, { idempotencyKey: 'refresh-emu-stale' });

    // A refresh lands between the reviewer's load and their write.
    const refreshed = narrativeDraft(3, ['https://acme.example/about', 'https://acme.example/newsroom']);
    await adminDb.collection('companies').doc(COMPANY_ID).update({ research: refreshed });

    // The projection is re-derived inside the transaction, so the stale write loses.
    await expect(recordCompanyReviewDecision(staleInput, ALICE)).rejects.toBeInstanceOf(CompanyReviewStaleDraftError);
    expect(await listCompanyReviewEvents(COMPANY_ID, ALICE.ownerId)).toHaveLength(0);

    // Cross-turn retry: reload, re-derive, approve the CURRENT draft.
    const current = await reload();
    const currentProjection = buildCompanyReviewProjection(current);
    expect(currentProjection.artifactVersion).toBe('3');

    const { outcome } = await approve(current, { idempotencyKey: 'refresh-emu-retry' });
    expect(outcome).toBe('recorded');

    const events = await listCompanyReviewEvents(COMPANY_ID, ALICE.ownerId);
    expect(deriveCompanyReviewReadiness(currentProjection, events).ready).toBe(true);
  });

  it('preserves a pre-refresh approval as history without counting it toward readiness', async () => {
    await seed(companyDoc(narrativeDraft(2, ['https://acme.example/about'])));
    const before = await reload();
    await approve(before, { idempotencyKey: 'refresh-emu-history' });

    // Refresh to a genuinely different draft.
    await adminDb
      .collection('companies')
      .doc(COMPANY_ID)
      .update({ research: narrativeDraft(3, ['https://acme.example/about', 'https://acme.example/ir']) });

    const after = await reload();
    const projection = buildCompanyReviewProjection(after);
    const events = await listCompanyReviewEvents(COMPANY_ID, ALICE.ownerId);

    expect(events).toHaveLength(1);
    expect(isStaleEvent(events[0], projection)).toBe(true);
    expect(deriveCompanyReviewReadiness(projection, events).ready).toBe(false);
    await expect(promoteApprovedCompanyReviewClaims(COMPANY_ID, ALICE.ownerId)).rejects.toBeInstanceOf(
      CompanyReviewNotReadyError
    );
  });
});

describe('AI-043 — structured draft still reaches promotion after a refresh', () => {
  it('approves every reviewable claim on the refreshed structured draft and promotes it', async () => {
    // No narrative block, so the structured artifact is the reviewed one.
    const structured = {
      lastResearched: 1_700_000_100,
      data: {
        citationsVerified: false,
        sourcingComplete: true,
        version: 9,
        receipts: { size: [{ url: 'https://reuters.com/acme', title: 'Reuters' }] },
        claimValues: { size: 'medium' },
      },
    };
    await seed(companyDoc(undefined as unknown as CompanyResearch, { research: null, aiResearch: structured }));

    const company = await reload();
    const projection = buildCompanyReviewProjection(company);
    expect(projection.artifactKind).toBe('structured');

    const area = projection.areas.find((a) => a.key === 'size')!;
    const result = await recordCompanyReviewDecision(
      {
        companyId: COMPANY_ID,
        artifactKind: 'structured',
        artifactVersion: projection.artifactVersion,
        area: 'size',
        areaDigest: area.areaDigest,
        draftDigest: projection.draftDigest,
        sourceIds: area.sourceIds,
        decision: 'approved',
        idempotencyKey: 'refresh-emu-structured',
      },
      ALICE
    );
    recordedIds.add(result.event.id);

    const promoted = await promoteApprovedCompanyReviewClaims(COMPANY_ID, ALICE.ownerId);
    expect(promoted.promoted).toContain('size');
    expect((await reload()).size).toBe('medium');
  });
});
